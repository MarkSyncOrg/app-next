import { browser } from 'wxt/browser';

// Reads the description and keywords a page publishes about itself, so bookmarking it
// does not start with two empty fields.
//
// This is where xBrowserSync's descriptions and tags come from too: they are not browser
// bookmark data — no browser has anywhere to keep them — but `<meta>` tags scraped from
// the page. Matching its precedence (Open Graph, then Twitter, then the plain meta name)
// keeps the two clients suggesting the same thing for the same page.
//
// The script runs against the active tab under `activeTab`, granted for that one tab
// because the user opened the popup over it. xBrowserSync instead asks for optional
// access to every http(s) site, which buys it the ability to scrape from the background
// when a bookmark is starred; that is a far larger permission than a sync tool should
// hold, so this reads the page only while the user is looking at the popup.

/** What a page says about itself, as far as a bookmark is concerned. */
export interface PageMetadata {
  description?: string;
  /** Raw keyword text (comma-separated); the caller normalises it into tags. */
  tags?: string;
}

/**
 * Collects the metadata. Serialised and executed in the page, so it has to be entirely
 * self-contained — no imports, no references to anything in this module.
 */
function collectPageMetadata(): { description?: string; tags?: string } {
  const contentOf = (...names: string[]): string | undefined => {
    for (const name of names) {
      const selector = `meta[name="${name}" i], meta[property="${name}" i]`;
      const content = document.querySelector<HTMLMetaElement>(selector)?.content?.trim();
      if (content) {
        return content;
      }
    }
    return undefined;
  };

  const keywords = new Set<string>();
  document.querySelectorAll<HTMLMetaElement>('meta[property="og:video:tag" i]').forEach((tag) => {
    const value = tag.content?.trim().toLowerCase();
    if (value) {
      keywords.add(value);
    }
  });
  for (const keyword of contentOf('keywords')?.split(',') ?? []) {
    const value = keyword.trim().toLowerCase();
    if (value) {
      keywords.add(value);
    }
  }

  return {
    description: contentOf('og:description', 'twitter:description', 'description'),
    tags: keywords.size > 0 ? [...keywords].join(', ') : undefined,
  };
}

/**
 * Runs the collector through whichever injection API this build has.
 *
 * MV3 takes the function directly. MV2 (the Firefox target) predates `scripting`, so it
 * gets the same function serialised into the `code` it accepts — one implementation, not
 * two that can drift. `collectPageMetadata` references nothing outside itself precisely
 * so that `toString()` remains valid standalone code.
 *
 * Firefox has supported `scripting` since well before this extension's minimum version,
 * so the fallback is a belt-and-braces path rather than the expected one; it is chosen by
 * feature detection instead of the build target so that whichever exists is used.
 */
async function inject(tabId: number): Promise<PageMetadata | undefined> {
  if (browser.scripting?.executeScript) {
    const [result] = await browser.scripting.executeScript({
      target: { tabId },
      func: collectPageMetadata,
    });
    return result?.result;
  }
  const legacy = (browser as { tabs: { executeScript?: unknown } }).tabs.executeScript as
    | ((tabId: number, details: { code: string }) => Promise<unknown[]>)
    | undefined;
  if (!legacy) {
    return undefined;
  }
  const [result] = await legacy(tabId, { code: `(${collectPageMetadata.toString()})()` });
  return result as PageMetadata | undefined;
}

/**
 * Reads the active tab's own metadata, or an empty result when it cannot be read.
 *
 * Never throws: a page that refuses injection (the extension gallery, a PDF, a
 * `view-source:` tab, a site whose CSP blocks it) is an ordinary outcome here, not an
 * error worth failing the editor over — the fields simply stay empty.
 */
export async function readPageMetadata(tabId: number | undefined): Promise<PageMetadata> {
  if (tabId === undefined) {
    return {};
  }
  try {
    return (await inject(tabId)) ?? {};
  } catch {
    return {};
  }
}
