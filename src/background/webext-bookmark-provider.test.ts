import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Bookmark,
  BookmarkContainer,
  BookmarkMetadataStore,
  MemoryStorageArea,
  SEPARATOR_URL,
} from '@marksyncorg/core';

/**
 * A stand-in for the WebExtension bookmarks API, faithful in the one respect this test
 * is about: a native node holds a title and a URL and has nowhere to put a description
 * or tags, so anything written through it comes back without them.
 */
interface FakeNode {
  id: string;
  title?: string;
  url?: string;
  children?: FakeNode[];
}

let nextId = 100;
let roots: Record<string, FakeNode>;

function findNode(node: FakeNode, id: string): FakeNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function lookup(id: string): FakeNode | undefined {
  for (const root of Object.values(roots)) {
    const found = findNode(root, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Every write the provider made, so a test can assert what it did *not* do. */
const writes = { create: 0, removeTree: 0, move: 0, update: 0 };

function findParent(node: FakeNode, id: string): FakeNode | undefined {
  for (const child of node.children ?? []) {
    if (child.id === id) {
      return node;
    }
    const found = findParent(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Takes a node out of its parent, anywhere in the tree. */
function detach(id: string): FakeNode | undefined {
  for (const root of Object.values(roots)) {
    const parent = findParent(root, id);
    if (parent) {
      const [node] = parent.children!.splice(
        parent.children!.findIndex((child) => child.id === id),
        1,
      );
      return node;
    }
  }
  return undefined;
}

const bookmarks = {
  getSubTree(id: string) {
    const node = roots[id];
    if (!node) {
      return Promise.reject(new Error(`No bookmark root ${id}`));
    }
    return Promise.resolve([node]);
  },
  create(details: { parentId: string; index?: number; title?: string; url?: string }) {
    writes.create += 1;
    const parent = lookup(details.parentId);
    if (!parent) {
      return Promise.reject(new Error(`No parent ${details.parentId}`));
    }
    // Only what a real native node can hold: no description, no tags.
    const node: FakeNode = {
      id: String((nextId += 1)),
      title: details.title,
      ...(details.url === undefined ? { children: [] } : { url: details.url }),
    };
    parent.children ??= [];
    parent.children.splice(details.index ?? parent.children.length, 0, node);
    return Promise.resolve(node);
  },
  move(id: string, destination: { parentId: string; index?: number }) {
    writes.move += 1;
    const node = detach(id);
    const parent = lookup(destination.parentId);
    if (!node || !parent) {
      return Promise.reject(new Error(`Cannot move ${id}`));
    }
    parent.children ??= [];
    parent.children.splice(destination.index ?? parent.children.length, 0, node);
    return Promise.resolve(node);
  },
  update(id: string, changes: { title?: string; url?: string }) {
    writes.update += 1;
    const node = lookup(id);
    if (!node) {
      return Promise.reject(new Error(`No node ${id}`));
    }
    Object.assign(node, changes);
    return Promise.resolve(node);
  },
  removeTree(id: string) {
    writes.removeTree += 1;
    if (!detach(id)) {
      return Promise.reject(new Error(`No node ${id}`));
    }
    return Promise.resolve();
  },
};

vi.mock('wxt/browser', () => ({ browser: { bookmarks } }));

// Imported after the mock is registered, since the module binds `browser` at import time.
const { WebextBookmarkProvider } = await import('./webext-bookmark-provider');

/** A provider over a fresh sidecar, plus the sidecar itself. */
function newProvider(withMetadata = true) {
  const metadata = new BookmarkMetadataStore(new MemoryStorageArea());
  return {
    metadata,
    provider: new WebextBookmarkProvider(withMetadata ? { metadata } : {}),
  };
}

/** The Other container holding a single described bookmark. */
function described(description?: string, tags?: string[]): Bookmark[] {
  return [
    {
      title: BookmarkContainer.Other,
      children: [
        {
          title: 'Example',
          url: 'https://example.org/',
          ...(description !== undefined && { description }),
          ...(tags !== undefined && { tags }),
        },
      ],
    },
  ];
}

beforeEach(() => {
  // import.meta.env.BROWSER is unset under vitest, so the Chromium roots apply.
  roots = {
    '1': { id: '1', title: 'Bookmarks bar', children: [] },
    '2': { id: '2', title: 'Other bookmarks', children: [] },
  };
  Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });
});

describe('WebextBookmarkProvider metadata', () => {
  it('reads back the description and tags the browser could not store', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(described('An example site', ['docs', 'reference']));

    // The native tree really did lose them…
    expect(roots['2']!.children![0]).not.toHaveProperty('description');
    // …and the provider hands them back all the same.
    const read = await provider.getBookmarks();
    const bookmark = read.find((c) => c.title === BookmarkContainer.Other)!.children![0]!;
    expect(bookmark.description).toBe('An example site');
    expect(bookmark.tags).toEqual(['docs', 'reference']);
  });

  it('does not report a pulled description as a local edit', async () => {
    // The regression the sidecar exists to prevent: a tree applied from the server has
    // to read back identical, or the engine sees a change nobody made and pushes the
    // stripped tree over everyone else's metadata.
    const { provider } = newProvider();
    // Both containers, as a tree arriving from the server has: the round trip has to be
    // exact, empty toolbar included.
    const pulled: Bookmark[] = [
      { title: BookmarkContainer.Toolbar, children: [] },
      ...described('An example site', ['docs']),
    ];
    await provider.setBookmarks(pulled);
    expect(await provider.getBookmarks()).toEqual(pulled);
  });

  it('forgets metadata removed from a tree that is applied again', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(described('An example site', ['docs']));
    // The description deleted on another device, arriving in a later pull.
    await provider.setBookmarks(described());

    const read = await provider.getBookmarks();
    const bookmark = read.find((c) => c.title === BookmarkContainer.Other)!.children![0]!;
    expect(bookmark.description).toBeUndefined();
    expect(bookmark.tags).toBeUndefined();
  });

  it('keeps working, without metadata, when no sidecar is configured', async () => {
    const { provider } = newProvider(false);
    await provider.setBookmarks(described('An example site'));
    const read = await provider.getBookmarks();
    expect(read.find((c) => c.title === BookmarkContainer.Other)!.children![0]!.description).toBe(
      undefined,
    );
  });
});

describe('WebextBookmarkProvider.createBookmark', () => {
  it('adds one bookmark without disturbing the rest of the tree', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(described('An example site'));

    expect(
      await provider.createBookmark(BookmarkContainer.Other, 'Added', 'https://added.org/'),
    ).toBe(true);

    const other = (await provider.getBookmarks()).find((c) => c.title === BookmarkContainer.Other)!;
    expect(other.children!.map((child) => child.url)).toEqual([
      'https://example.org/',
      'https://added.org/',
    ]);
    // The bookmark that was already there keeps its description.
    expect(other.children![0]!.description).toBe('An example site');
  });

  it('reports when the container is not synced on this browser', async () => {
    const { provider } = newProvider();
    // Chromium has no Menu container.
    expect(await provider.createBookmark(BookmarkContainer.Menu, 'X', 'https://x.org/')).toBe(
      false,
    );
  });

  it('respects a toolbar excluded from the sync', async () => {
    const metadata = new BookmarkMetadataStore(new MemoryStorageArea());
    const provider = new WebextBookmarkProvider({
      metadata,
      isToolbarEnabled: () => Promise.resolve(false),
    });
    expect(await provider.createBookmark(BookmarkContainer.Toolbar, 'X', 'https://x.org/')).toBe(
      false,
    );
  });
});

/** The Other container, holding the given bookmarks in order. */
function other(...titles: string[]): Bookmark[] {
  return [
    {
      title: BookmarkContainer.Other,
      children: titles.map((title) => ({
        title,
        url: `https://${title.toLowerCase()}.org/`,
      })),
    },
  ];
}

/** The Other container's native children, as `title` pairs with their native IDs. */
function nativeOther(): { title?: string; id: string }[] {
  return (roots['2']!.children ?? []).map(({ title, id }) => ({ title, id }));
}

describe('WebextBookmarkProvider.setBookmarks', () => {
  it('writes nothing at all when the tree already matches', async () => {
    // The regression behind issue #22: every sync used to empty each container and
    // rebuild it, so the bookmarks toolbar visibly cleared and refilled even when the
    // pull carried no change at all.
    const { provider } = newProvider();
    await provider.setBookmarks(other('A', 'B', 'C'));
    const before = nativeOther();
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks(other('A', 'B', 'C'));

    expect(writes).toEqual({ create: 0, removeTree: 0, move: 0, update: 0 });
    // Same nodes, not replacements: a rebuild would have handed out fresh IDs.
    expect(nativeOther()).toEqual(before);
  });

  it('adds and removes only the bookmarks that differ', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(other('A', 'B', 'C'));
    const kept = nativeOther().filter(({ title }) => title !== 'B');
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks(other('A', 'C', 'D'));

    expect(writes).toEqual({ create: 1, removeTree: 1, move: 0, update: 0 });
    expect(nativeOther().map(({ title }) => title)).toEqual(['A', 'C', 'D']);
    // A and C are the very same nodes they were before D arrived.
    expect(nativeOther().slice(0, 2)).toEqual(kept);
  });

  it('reorders by moving, keeping every node', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(other('A', 'B', 'C'));
    const before = nativeOther();
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks(other('C', 'A', 'B'));

    expect(writes.create).toBe(0);
    expect(writes.removeTree).toBe(0);
    expect(writes.move).toBeGreaterThan(0);
    expect(nativeOther()).toEqual([before[2], before[0], before[1]]);
  });

  it('retitles a bookmark in place rather than replacing it', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(other('A'));
    const [before] = nativeOther();
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks([
      { title: BookmarkContainer.Other, children: [{ title: 'Renamed', url: 'https://a.org/' }] },
    ]);

    expect(writes).toEqual({ create: 0, removeTree: 0, move: 0, update: 1 });
    expect(nativeOther()).toEqual([{ title: 'Renamed', id: before!.id }]);
  });

  it('reconciles inside a folder both trees have', async () => {
    const folder = (...titles: string[]): Bookmark[] => [
      {
        title: BookmarkContainer.Other,
        children: [
          {
            title: 'Folder',
            children: titles.map((title) => ({ title, url: `https://${title}.org/` })),
          },
        ],
      },
    ];
    const { provider } = newProvider();
    await provider.setBookmarks(folder('a', 'b'));
    const folderId = roots['2']!.children![0]!.id;
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks(folder('a', 'b', 'c'));

    expect(writes).toEqual({ create: 1, removeTree: 0, move: 0, update: 0 });
    // The folder itself was never touched, only its contents.
    expect(roots['2']!.children![0]!.id).toBe(folderId);
    expect(roots['2']!.children![0]!.children!.map((child) => child.title)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('leaves a container it has no local root for alone', async () => {
    const { provider } = newProvider();
    // Chromium has no Menu root; the write must skip it rather than fail.
    await provider.setBookmarks([
      { title: BookmarkContainer.Menu, children: [{ title: 'M', url: 'https://m.org/' }] },
      ...other('A'),
    ]);
    expect(nativeOther().map(({ title }) => title)).toEqual(['A']);
  });

  it('empties a container the tree says is empty', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(other('A', 'B'));
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks([{ title: BookmarkContainer.Other, children: [] }]);

    expect(writes).toEqual({ create: 0, removeTree: 2, move: 0, update: 0 });
    expect(nativeOther()).toEqual([]);
  });

  it('does not rewrite a container the change did not touch', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks([
      { title: BookmarkContainer.Toolbar, children: [{ title: 'T', url: 'https://t.org/' }] },
      ...other('A'),
    ]);
    const toolbarBefore = roots['1']!.children!.map(({ id }) => id);
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    // A bookmark added in Other, on another device: the toolbar must not move.
    await provider.setBookmarks([
      { title: BookmarkContainer.Toolbar, children: [{ title: 'T', url: 'https://t.org/' }] },
      ...other('A', 'B'),
    ]);

    expect(writes).toEqual({ create: 1, removeTree: 0, move: 0, update: 0 });
    expect(roots['1']!.children!.map(({ id }) => id)).toEqual(toolbarBefore);
  });

  it('matches repeats of one URL by position, as the merge does', async () => {
    const twice = (...titles: string[]): Bookmark[] => [
      {
        title: BookmarkContainer.Other,
        children: titles.map((title) => ({ title, url: 'https://same.org/' })),
      },
    ];
    const { provider } = newProvider();
    await provider.setBookmarks(twice('First', 'Second'));
    const before = nativeOther();
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks(twice('First', 'Second'));

    expect(writes).toEqual({ create: 0, removeTree: 0, move: 0, update: 0 });
    expect(nativeOther()).toEqual(before);
  });
});

describe('WebextBookmarkProvider separators', () => {
  const withSeparator: Bookmark[] = [
    {
      title: BookmarkContainer.Other,
      children: [
        { title: 'A', url: 'https://a.org/' },
        { url: SEPARATOR_URL },
        { title: 'B', url: 'https://b.org/' },
      ],
    },
  ];

  it('tells the sync engine it cannot hold one', () => {
    // import.meta.env.BROWSER is unset under vitest, so this is the Chromium build.
    expect(new WebextBookmarkProvider().holdsSeparators).toBe(false);
  });

  it('skips it without disturbing the bookmarks around it', async () => {
    const { provider } = newProvider();
    await provider.setBookmarks(withSeparator);
    expect(nativeOther().map(({ title }) => title)).toEqual(['A', 'B']);
  });

  it('writes nothing when the same tree is applied again', async () => {
    // The position the separator would have occupied must not shift what follows it,
    // or every apply would look like a reorder and move B for no reason.
    const { provider } = newProvider();
    await provider.setBookmarks(withSeparator);
    const before = nativeOther();
    Object.assign(writes, { create: 0, removeTree: 0, move: 0, update: 0 });

    await provider.setBookmarks(withSeparator);

    expect(writes).toEqual({ create: 0, removeTree: 0, move: 0, update: 0 });
    expect(nativeOther()).toEqual(before);
  });
});
