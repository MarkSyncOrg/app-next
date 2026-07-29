import { browser } from 'wxt/browser';
import {
  type Bookmark,
  BookmarkContainer,
  type BookmarkProvider,
  nativeToBookmarks,
  SEPARATOR_URL,
} from '@marksyncorg/core';
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
 * Origin of a URL, or `'invalid-url'`. Bookmark titles and full URLs are never logged
 * (the debug log is downloadable and gets attached to bug reports); the origin is
 * enough to tell which entry a mapping error came from.
 */
function originOf(url: string | undefined): string {
  if (!url) {
    return 'none';
  }
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}

/**
 * BookmarkProvider backed by the WebExtension bookmarks API. This is the single
 * browser-specific seam of the sync engine. `setBookmarks` is destructive: it replaces
 * the contents of each container root with the synced tree (full-tree sync).
 */
export interface WebextBookmarkProviderOptions {
  /** Resolves whether the toolbar/bar container should be included in the sync. */
  isToolbarEnabled?: () => Promise<boolean>;
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
    return containers;
  }

  async setBookmarks(bookmarks: Bookmark[]): Promise<void> {
    const rootByContainer = new Map(
      (await this.includedRoots()).map(({ container, rootId }) => [container as string, rootId]),
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
          origin: originOf(bookmark.url),
        });
        throw error;
      }
    }
    return created;
  }
}
