import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Bookmark,
  BookmarkContainer,
  BookmarkMetadataStore,
  MemoryStorageArea,
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

const bookmarks = {
  getSubTree(id: string) {
    const node = roots[id];
    if (!node) {
      return Promise.reject(new Error(`No bookmark root ${id}`));
    }
    return Promise.resolve([node]);
  },
  create(details: { parentId: string; title?: string; url?: string }) {
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
    parent.children.push(node);
    return Promise.resolve(node);
  },
  removeTree(id: string) {
    for (const root of Object.values(roots)) {
      const parent = root.children?.some((child) => child.id === id) ? root : undefined;
      if (parent) {
        parent.children = parent.children!.filter((child) => child.id !== id);
        return Promise.resolve();
      }
    }
    return Promise.reject(new Error(`No node ${id}`));
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
