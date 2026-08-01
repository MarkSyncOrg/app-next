import { describe, expect, it } from 'vitest';
import { SEPARATOR_URL } from '@marksyncorg/core';
import { stripExecutableUrls } from './executable-urls';

describe('stripExecutableUrls', () => {
  it('keeps ordinary bookmarks untouched', () => {
    const bookmarks = [
      { title: 'Toolbar', children: [{ title: 'Example', url: 'https://example.org/' }] },
    ];
    const result = stripExecutableUrls(bookmarks);
    expect(result.removed).toBe(0);
    expect(result.bookmarks).toEqual(bookmarks);
  });

  it('drops bookmarks whose URL executes when clicked', () => {
    const result = stripExecutableUrls([
      { title: 'Bookmarklet', url: 'javascript:alert(1)' },
      { title: 'Inline page', url: 'data:text/html,<script>alert(1)</script>' },
      { title: 'Legacy', url: 'VBScript:msgbox(1)' },
      { title: 'Fine', url: 'https://example.org/' },
    ]);
    expect(result.removed).toBe(3);
    expect(result.bookmarks).toEqual([{ title: 'Fine', url: 'https://example.org/' }]);
  });

  it('sees through whitespace and control characters in the scheme', () => {
    // Browsers strip these while resolving the scheme, so the URL still executes.
    const result = stripExecutableUrls([
      { title: 'Padded', url: '  javascript:alert(1)' },
      { title: 'Split', url: 'java\nscript:alert(1)' },
      { title: 'Tabbed', url: 'java\tscript:alert(1)' },
      { title: 'Nulled', url: '\u0000javascript:alert(1)' },
    ]);
    expect(result.removed).toBe(4);
    expect(result.bookmarks).toEqual([]);
  });

  it('removes nested bookmarks but keeps the folders around them', () => {
    const result = stripExecutableUrls([
      {
        title: 'Toolbar',
        children: [
          { title: 'Tools', children: [{ title: 'Evil', url: 'javascript:alert(1)' }] },
          { title: 'Example', url: 'https://example.org/' },
        ],
      },
    ]);
    expect(result.removed).toBe(1);
    expect(result.bookmarks).toEqual([
      {
        title: 'Toolbar',
        children: [
          { title: 'Tools', children: [] },
          { title: 'Example', url: 'https://example.org/' },
        ],
      },
    ]);
  });

  it('keeps separators, which carry a sentinel URL rather than a real one', () => {
    const bookmarks = [{ url: SEPARATOR_URL }];
    expect(stripExecutableUrls(bookmarks)).toEqual({ bookmarks, removed: 0 });
  });
});
