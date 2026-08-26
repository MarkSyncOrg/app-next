import { type Browser, browser } from 'wxt/browser';
import {
  applyBookmarkMetadata,
  type Bookmark,
  BookmarkContainer,
  type BookmarkMetadataStore,
  type BookmarkProvider,
  captureBookmarkMetadata,
  keyBookmarkSiblings,
  nativeToBookmarks,
  SEPARATOR_URL,
} from '@marksyncorg/core';
import { urlOrigin } from '../logging/log-entry';
import { Logger } from '../logging/logger';

interface ContainerRoot {
  container: BookmarkContainer;
  rootId: string;
}

/** A node of the browser's own bookmark tree. */
type NativeNode = Browser.bookmarks.BookmarkTreeNode;

/** What applying a tree actually changed, for the log. */
interface BookmarkChange {
  created: number;
  removed: number;
  moved: number;
  updated: number;
}

function noChange(): BookmarkChange {
  return { created: 0, removed: 0, moved: 0, updated: 0 };
}

function addChange(total: BookmarkChange, part: BookmarkChange): void {
  total.created += part.created;
  total.removed += part.removed;
  total.moved += part.moved;
  total.updated += part.updated;
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
 * browser-specific seam of the sync engine. `setBookmarks` reconciles each container
 * root against the synced tree, writing only the nodes that actually differ.
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

  /**
   * Brings each synced container root in line with the tree it is given, writing only
   * what differs.
   *
   * This used to empty every container and rebuild it node by node, which is what the
   * bookmarks toolbar visibly emptying and refilling on every sync was (issue #22). It
   * also threw away everything the browser keeps beside a bookmark's title and URL —
   * its ID, the date it was added, the folder's open state, its place in "recently
   * added" — and asked for a fresh favicon for each one, on every pull, whether or not
   * anything about that bookmark had changed. Reconciling costs one read per container
   * and leaves an unchanged bookmark untouched, so an apply that changes nothing writes
   * nothing and raises no bookmark events at all.
   *
   * Nodes are matched by the content-based identity the merge and the metadata sidecar
   * already share (`keyBookmarkSiblings`): folders by title, bookmarks by URL,
   * separators by position, repeats within one folder by occurrence. A node that
   * survives the comparison keeps its native identity; only genuine additions,
   * deletions, reorderings and retitlings are written.
   */
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
    const total = noChange();
    for (const container of bookmarks) {
      const rootId = container.title ? rootByContainer.get(container.title) : undefined;
      if (!rootId) {
        await this.log.debug('Skipping container with no local root', {
          container: container.title,
        });
        continue;
      }
      const root = await this.getRoot(rootId);
      if (!root) {
        continue;
      }
      const change = noChange();
      await this.reconcileChildren(rootId, root.children ?? [], container.children ?? [], change);
      addChange(total, change);
      await this.log.debug('Reconciled container contents', {
        container: container.title,
        rootId,
        ...change,
      });
    }
    await this.log.info('Applied bookmarks to the browser', {
      containers: bookmarks.length,
      ...total,
    });
  }

  /**
   * Makes `parentId`'s children match `target`, recursing into the folders both sides
   * have. Counts what it wrote into `change`.
   */
  private async reconcileChildren(
    parentId: string,
    existing: readonly NativeNode[],
    target: readonly Bookmark[],
    change: BookmarkChange,
  ): Promise<void> {
    // Snapshotted: the writes below reach into the very array the browser handed us,
    // and the positions have to keep pointing at the tree we compared against.
    const nodes = [...existing];
    const keyedExisting = keyBookmarkSiblings(nativeToBookmarks(nodes));
    const byKey = new Map<string, NativeNode>();
    keyedExisting.forEach(({ key }, position) => byKey.set(key, nodes[position]!));
    const keyedTarget = keyBookmarkSiblings(target);
    const wanted = new Set(keyedTarget.map(({ key }) => key));

    // Removals first, so `order` — our running picture of what the browser now holds —
    // starts from the nodes that survive.
    const order: NativeNode[] = [];
    for (const [position, { key }] of keyedExisting.entries()) {
      const node = nodes[position]!;
      if (wanted.has(key)) {
        order.push(node);
        continue;
      }
      await this.removeTree(parentId, node.id);
      change.removed += 1;
    }

    let index = 0;
    for (const { key, node: wantedNode } of keyedTarget) {
      const current = byKey.get(key);
      if (!current) {
        const created = await this.createNode(parentId, wantedNode, index, change);
        if (created) {
          order.splice(index, 0, created);
          index += 1;
        }
        // Nothing was written (a separator on a browser without them), so the next node
        // takes this position instead.
        continue;
      }
      const at = order.indexOf(current);
      if (at !== index) {
        // Always a move towards the front: every position before `index` already holds
        // the node the target wants there, so the one being placed sits further along.
        // That matters — browsers disagree about whether a move index is read before or
        // after the node leaves its old slot, and the two readings only differ when a
        // node moves backwards.
        await this.move(parentId, current.id, index);
        order.splice(at, 1);
        order.splice(index, 0, current);
        change.moved += 1;
      }
      if (await this.retitle(current, wantedNode)) {
        change.updated += 1;
      }
      if (!wantedNode.url) {
        await this.reconcileChildren(
          current.id,
          current.children ?? [],
          wantedNode.children ?? [],
          change,
        );
      }
      index += 1;
    }
  }

  /**
   * Creates one node (and, for a folder, everything under it) at `index`, resolving with
   * the native node written — or undefined when this browser cannot represent it.
   */
  private async createNode(
    parentId: string,
    bookmark: Bookmark,
    index: number,
    change: BookmarkChange,
  ): Promise<NativeNode | undefined> {
    try {
      if (bookmark.url === SEPARATOR_URL) {
        // Only Firefox supports native separators; Chromium has no equivalent.
        // `type` is absent from the shared (Chromium) CreateDetails type.
        if (import.meta.env.BROWSER !== 'firefox') {
          return undefined;
        }
        const details = { parentId, index, type: 'separator' } as Parameters<
          typeof browser.bookmarks.create
        >[0];
        const separator = await browser.bookmarks.create(details);
        change.created += 1;
        return separator;
      }
      if (bookmark.url) {
        const created = await browser.bookmarks.create({
          parentId,
          index,
          title: bookmark.title,
          url: bookmark.url,
        });
        change.created += 1;
        return created;
      }
      const folder = await browser.bookmarks.create({ parentId, index, title: bookmark.title });
      change.created += 1;
      await this.reconcileChildren(folder.id, [], bookmark.children ?? [], change);
      return folder;
    } catch (error) {
      await this.log.failure('Failed to create a bookmark', error, {
        parentId,
        kind: bookmark.url ? 'bookmark' : 'folder',
        origin: urlOrigin(bookmark.url),
      });
      throw error;
    }
  }

  /**
   * Writes a matched node's title when the tree asks for a different one; resolves true
   * if it wrote. Folders and separators never reach the write: a folder's title is what
   * matched it, and a separator has none.
   */
  private async retitle(current: NativeNode, wanted: Bookmark): Promise<boolean> {
    // Compared against the converted node rather than the raw one, because
    // `nativeToBookmarks` trims: a stored title with stray whitespace around it would
    // otherwise be rewritten on every single apply.
    const [converted] = nativeToBookmarks([current]);
    const title = wanted.title ?? '';
    if ((converted?.title ?? '') === title) {
      return false;
    }
    try {
      await browser.bookmarks.update(current.id, { title });
    } catch (error) {
      await this.log.failure('Failed to retitle a bookmark', error, { id: current.id });
      throw error;
    }
    return true;
  }

  private async move(parentId: string, id: string, index: number): Promise<void> {
    try {
      await browser.bookmarks.move(id, { parentId, index });
    } catch (error) {
      await this.log.failure('Failed to move a bookmark', error, { parentId, id, index });
      throw error;
    }
  }

  private async removeTree(parentId: string, id: string): Promise<void> {
    try {
      await browser.bookmarks.removeTree(id);
    } catch (error) {
      await this.log.failure('Failed to remove a bookmark tree', error, { parentId, id });
      throw error;
    }
  }

  /**
   * Creates a single bookmark at the end of a container, leaving the rest of the tree
   * alone. Unlike {@link setBookmarks} it answers to nothing but its own arguments — it
   * exists so the popup can bookmark the page the user is on without consulting, or
   * touching, the rest of the tree.
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
}
