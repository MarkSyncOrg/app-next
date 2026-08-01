import type { Bookmark } from '@marksyncorg/core';

/**
 * Bookmarks whose URL runs code when the bookmark is clicked.
 *
 * A hostile *server* cannot plant one of these: sync payloads are AES-GCM sealed, so
 * nothing that did not come from this user's own encrypted data ever reaches the
 * bookmarks API. An imported backup file is the one path that bypasses that, which is
 * why the filter lives at the import boundary and not in the sync path — bookmarklets
 * a user already keeps locally must keep syncing normally.
 */
const EXECUTABLE_SCHEMES = ['javascript:', 'data:', 'vbscript:'];

/** Whether a URL would execute when opened. */
function isExecutableUrl(url: string): boolean {
  // Browsers ignore whitespace and control characters while resolving a scheme, so
  // `java\nscript:alert(1)` still runs. Strip them all before comparing.
  // Compared by code point rather than a regex: a character class spanning the control
  // range trips `no-control-regex`, and this says the same thing more plainly.
  const normalised = Array.from(url)
    .filter((character) => character > ' ')
    .join('')
    .toLowerCase();
  return EXECUTABLE_SCHEMES.some((scheme) => normalised.startsWith(scheme));
}

export interface StripResult {
  /** The tree with executable bookmarks removed. */
  bookmarks: Bookmark[];
  /** How many bookmarks were dropped, so the user can be told. */
  removed: number;
}

/**
 * Removes bookmarks with an executable URL from a parsed backup, preserving the rest of
 * the tree. Folders are kept even when everything inside them is dropped: an empty
 * folder is a visible hint that something was removed.
 */
export function stripExecutableUrls(bookmarks: Bookmark[]): StripResult {
  let removed = 0;

  function walk(nodes: Bookmark[]): Bookmark[] {
    const kept: Bookmark[] = [];
    for (const node of nodes) {
      if (node.url !== undefined && isExecutableUrl(node.url)) {
        removed += 1;
        continue;
      }
      kept.push(node.children ? { ...node, children: walk(node.children) } : node);
    }
    return kept;
  }

  return { bookmarks: walk(bookmarks), removed };
}
