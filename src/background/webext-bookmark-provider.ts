import { browser } from 'wxt/browser';
import {
  applyBookmarkMetadata,
  type Bookmark,
  BookmarkContainer,
  type BookmarkMetadataStore,
  type BookmarkProvider,
  captureBookmarkMetadata,
  nativeToBookmarks,
  SEPARATOR_URL,
} from '@marksyncorg/core';
import { urlOrigin } from '../logging/log-entry';
import { Logger } from '../logging/logger';

interface ContainerRoot {
  container: BookmarkContainer;
  rootId: string;
}

/**
 * Maps xBrowserSync containers to the browser's native bookmark root IDs. Chromium
 * exposes the bookmarks bar ('1') and other bookmarks ('2'); Firefox uses named roots
 * and additionally has a bookmarks menu.
 */
function getContainerRoots(): ContainerRoot[] {
  if (import.meta.env.BROWSER === 'firefox') {
    return [
      { container: BookmarkContainer.Toolbar, rootId: 'toolbar_____' },
      { container: BookmarkContainer.Menu, rootId: 'menu________' },
      { container: BookmarkContainer.Other, rootId: 'unfiled_____' },
    ];
  }
  return [
    { container: BookmarkContainer.Toolbar, rootId: '1' },
    { container: BookmarkContainer.Other, rootId: '2' },
  ];
}

/** Total number of nodes in a bookmark tree, used for log counts. */
function countBookmarks(bookmarks: Bookmark[]): number {
  return bookmarks.reduce(
    (total, bookmark) => total + 1 + countBookmarks(bookmark.children ?? []),
    0,
  );
}

/**
 * BookmarkProvider backed by the WebExtension bookmarks API. This is the single
 * browser-specific seam of the sync engine. `setBookmarks` is destructive: it replaces
 * the contents of each container root with the synced tree (full-tree sync).
 */
export interface WebextBookmarkProviderOptions {
  /** Resolves whether the toolbar/bar container should be included in the sync. */
  isToolbarEnabled?: () => Promise<boolean>;
  /**
   * Sidecar for the description and tags a native bookmark node cannot hold. Without
   * one the provider still works, but those attributes do not survive a read: the
   * browser drops them, and the sync engine then reads the loss as a local edit and
   * pushes a tree with every description and tag stripped out.
   */
  metadata?: BookmarkMetadataStore;
  /** Where to trace bookmark reads/writes; defaults to a logger with no sinks. */
  logger?: Logger;
}

export class WebextBookmarkProvider implements BookmarkProvider {
  private readonly log: Logger;

  constructor(private readonly options: WebextBookmarkProviderOptions = {}) {
    this.log = options.logger ?? new Logger();
  }

  /** Container roots to sync, honouring the toolbar setting. */
  private async includedRoots(): Promise<ContainerRoot[]> {
    const roots = getContainerRoots();
    if (this.options.isToolbarEnabled && !(await this.options.isToolbarEnabled())) {
      await this.log.debug('Excluding the toolbar container (setting is off)');
      return roots.filter((root) => root.container !== BookmarkContainer.Toolbar);
    }
    return roots;
  }

  async getBookmarks(): Promise<Bookmark[]> {
    const containers: Bookmark[] = [];
    for (const { container, rootId } of await this.includedRoots()) {
      const root = await this.getRoot(rootId);
      if (!root) {
        await this.log.debug('Container root not available in this browser', {
          container,
          rootId,
        });
        continue;
      }
      const children = nativeToBookmarks(root.children ?? []);
      await this.log.debug('Read container', {
        container,
        rootId,
        items: countBookmarks(children),
      });
      containers.push({ title: container, children });
    }
    await this.log.debug('Read local bookmarks', {
      containers: containers.length,
      items: countBookmarks(containers) - containers.length,
    });
    return this.withMetadata(containers);
  }

  /**
   * Lays the stored description and tags back over a tree the browser just handed us.
   *
   * The WebExtension bookmarks API has no field for either, so every read comes back
   * without them. Restoring them here — rather than anywhere above the provider — is
   * what makes the whole sync engine see complete bookmarks: dirty detection compares
   * them, the merge merges them, and the upload carries them.
   */
  private async withMetadata(bookmarks: Bookmark[]): Promise<Bookmark[]> {
    if (!this.options.metadata) {
      return bookmarks;
    }
    const stored = await this.options.metadata.getAll();
    const applied = applyBookmarkMetadata(bookmarks, stored);
    await this.log.debug('Applied stored bookmark metadata', {
      entries: Object.keys(stored).length,
    });
    return applied;
  }

  async setBookmarks(bookmarks: Bookmark[]): Promise<void> {
    const rootByContainer = new Map(
      (await this.includedRoots()).map(({ container, rootId }) => [container as string, rootId]),
    );
    // Recorded before the native write, which is what discards the metadata: if the
    // write fails part-way the sidecar still describes the tree we were asked to store,
    // and the next read lays it back over whatever survived.
    //
    // Only the containers the write actually reaches. A container with no local root —
    // the Menu on Chromium, or a toolbar the user excluded — is skipped below, and
    // capturing it would replace the entries of a container this device never wrote.
    await this.captureMetadata(
      bookmarks.filter((container) => container.title && rootByContainer.has(container.title)),
    );
    let removedTotal = 0;
    let createdTotal = 0;
    for (const container of bookmarks) {
      const rootId = container.title ? rootByContainer.get(container.title) : undefined;
      if (!rootId) {
        await this.log.debug('Skipping container with no local root', {
          container: container.title,
        });
        continue;
      }
      const removed = await this.clearChildren(rootId);
      const created = await this.createChildren(rootId, container.children ?? []);
      removedTotal += removed;
      createdTotal += created;
      await this.log.debug('Replaced container contents', {
        container: container.title,
        rootId,
        removedTrees: removed,
        created,
      });
    }
    await this.log.info('Applied bookmarks to the browser', {
      containers: bookmarks.length,
      removedTrees: removedTotal,
      created: createdTotal,
    });
  }

  /**
   * Creates a single bookmark at the end of a container, leaving the rest of the tree
   * alone. Unlike {@link setBookmarks} this is additive — it exists so the popup can
   * bookmark the page the user is on without rewriting every bookmark they have.
   *
   * Resolves false when the container is not synced on this browser (no Menu container
   * on Chromium, or a toolbar the user excluded), so the caller can say why nothing
   * happened rather than reporting a success that did not occur.
   */
  async createBookmark(container: BookmarkContainer, title: string, url: string): Promise<boolean> {
    const root = (await this.includedRoots()).find((entry) => entry.container === container);
    if (!root) {
      await this.log.debug('Cannot create a bookmark: container is not synced', { container });
      return false;
    }
    await browser.bookmarks.create({ parentId: root.rootId, title, url });
    await this.log.info('Created a bookmark', { container, origin: urlOrigin(url) });
    return true;
  }

  /** Records the metadata of a tree about to be written, so the next read can restore it. */
  private async captureMetadata(bookmarks: Bookmark[]): Promise<void> {
    const store = this.options.metadata;
    if (!store) {
      return;
    }
    const captured = captureBookmarkMetadata(await store.getAll(), bookmarks);
    await store.setAll(captured);
    await this.log.debug('Captured bookmark metadata', { entries: Object.keys(captured).length });
  }

  private async getRoot(rootId: string) {
    try {
      const [root] = await browser.bookmarks.getSubTree(rootId);
      return root;
    } catch (error) {
      // Root not present in this browser (e.g. no Menu container on Chromium).
      await this.log.debug('Bookmark root not readable', {
        rootId,
        reason: (error as Error).message,
      });
      return undefined;
    }
  }

  /** Removes every child tree of a root; resolves with how many were removed. */
  private async clearChildren(rootId: string): Promise<number> {
    const root = await this.getRoot(rootId);
    const children = root?.children ?? [];
    for (const child of children) {
      try {
        await browser.bookmarks.removeTree(child.id);
      } catch (error) {
        await this.log.failure('Failed to remove a bookmark tree', error, {
          rootId,
          id: child.id,
        });
        throw error;
      }
    }
    return children.length;
  }

  /** Recreates a bookmark tree under `parentId`; resolves with how many nodes were created. */
  private async createChildren(parentId: string, bookmarks: Bookmark[]): Promise<number> {
    let created = 0;
    for (const bookmark of bookmarks) {
      try {
        if (bookmark.url === SEPARATOR_URL) {
          // Only Firefox supports native separators; Chromium has no equivalent.
          // `type` is absent from the shared (Chromium) CreateDetails type.
          if (import.meta.env.BROWSER === 'firefox') {
            const details = { parentId, type: 'separator' } as Parameters<
              typeof browser.bookmarks.create
            >[0];
            await browser.bookmarks.create(details);
            created += 1;
          }
          continue;
        }
        if (bookmark.url) {
          await browser.bookmarks.create({ parentId, title: bookmark.title, url: bookmark.url });
          created += 1;
        } else {
          const folder = await browser.bookmarks.create({ parentId, title: bookmark.title });
          created += 1;
          created += await this.createChildren(folder.id, bookmark.children ?? []);
        }
      } catch (error) {
        await this.log.failure('Failed to create a bookmark', error, {
          parentId,
          kind: bookmark.url ? 'bookmark' : 'folder',
          origin: urlOrigin(bookmark.url),
        });
        throw error;
      }
    }
    return created;
  }
}
