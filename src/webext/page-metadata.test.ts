import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { scripting: {}, tabs: {} } }));

const { readPageMetadata } = await import('./page-metadata');

/** A meta tag, as the collector sees it. */
interface FakeMeta {
  name?: string;
  property?: string;
  content: string;
}

/**
 * The smallest `document` the collector needs: `querySelector`/`querySelectorAll` over a
 * list of meta tags, matched on the attribute values quoted in the selector.
 *
 * A real DOM would need jsdom, and a dev dependency for one test is a poor trade against
 * this project's supply-chain gate. What that costs is the selector *syntax* — the `i`
 * flag and the attribute forms are only exercised in a real browser; what it keeps is the
 * logic worth testing, which is the precedence between the three description sources and
 * how keywords are collected.
 */
function fakeDocument(metas: FakeMeta[]): Document {
  const quoted = (selector: string): string[] =>
    [...selector.matchAll(/"([^"]+)"/g)].map(([, value]) => (value ?? '').toLowerCase());
  const matching = (selector: string): FakeMeta[] => {
    const wanted = quoted(selector);
    return metas.filter((meta) =>
      wanted.includes((meta.name ?? meta.property ?? '').toLowerCase()),
    );
  };
  return {
    querySelector: (selector: string) => matching(selector)[0],
    querySelectorAll: (selector: string) => matching(selector),
  } as unknown as Document;
}

/**
 * Runs the collector the way an injection would.
 *
 * It is reached through the `toString()` the MV2 path serialises, rather than exported
 * just for the test. That also proves it stays self-contained: anything it closed over
 * would fail to evaluate here.
 */
async function collectFrom(metas: FakeMeta[]): Promise<{ description?: string; tags?: string }> {
  let injected: string | undefined;
  const { browser } = await import('wxt/browser');
  (browser as unknown as { tabs: { executeScript: unknown } }).tabs.executeScript = (
    _tabId: number,
    details: { code: string },
  ) => {
    injected = details.code;
    return Promise.resolve([undefined]);
  };
  await readPageMetadata(1);

  return new Function('document', `return ${injected!}`)(fakeDocument(metas)) as {
    description?: string;
    tags?: string;
  };
}

describe('the page metadata collector', () => {
  it('prefers Open Graph, then Twitter, then the plain description', async () => {
    const all = await collectFrom([
      { name: 'description', content: 'plain' },
      { name: 'twitter:description', content: 'twitter' },
      { property: 'og:description', content: 'open graph' },
    ]);
    expect(all.description).toBe('open graph');

    const noOg = await collectFrom([
      { name: 'description', content: 'plain' },
      { name: 'twitter:description', content: 'twitter' },
    ]);
    expect(noOg.description).toBe('twitter');

    const plainOnly = await collectFrom([{ name: 'description', content: 'plain' }]);
    expect(plainOnly.description).toBe('plain');
  });

  it('reads keywords and video tags, lower-cased and de-duplicated', async () => {
    const { tags } = await collectFrom([
      { name: 'keywords', content: 'News, tech ,, NEWS' },
      { property: 'og:video:tag', content: 'Video' },
    ]);
    expect(tags).toBe('video, news, tech');
  });

  it('returns nothing for a page that says nothing about itself', async () => {
    expect(await collectFrom([])).toEqual({
      description: undefined,
      tags: undefined,
    });
  });

  it('ignores empty meta content rather than reporting a blank description', async () => {
    const { description } = await collectFrom([
      { property: 'og:description', content: '   ' },
      { name: 'description', content: 'plain' },
    ]);
    expect(description).toBe('plain');
  });
});

describe('readPageMetadata', () => {
  it('gives up quietly when there is no tab or the page refuses injection', async () => {
    const { browser } = await import('wxt/browser');
    expect(await readPageMetadata(undefined)).toEqual({});

    (browser as unknown as { tabs: { executeScript: unknown } }).tabs.executeScript = () =>
      Promise.reject(new Error('Cannot access contents of the page'));
    expect(await readPageMetadata(1)).toEqual({});
  });
});
