import { type BrowserContext, chromium, expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real-browser integration test for the bookmark provider and the full sync flow.
// Requires a backend, so it is skipped unless XBS_CONTRACT_URL is set:
//
//   docker compose -f contract/docker-compose.yml up -d
//   XBS_CONTRACT_URL=http://localhost:8080 npm run test:e2e
//
// It simulates two devices: device A creates a bookmark and a new sync, device B
// enables that sync and must receive the bookmark natively — exercising both
// getBookmarks (push) and setBookmarks (apply) against a real Chromium profile.
const serviceUrl = process.env.XBS_CONTRACT_URL;
const maybe = serviceUrl ? test : test.skip;

const extensionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.output/chrome-mv3',
);

interface ChromeApi {
  bookmarks: {
    create(b: { parentId?: string; title?: string; url?: string }): Promise<{ id: string }>;
    search(query: { url?: string }): Promise<{ id: string }[]>;
  };
}

const BOOKMARK_URL = 'https://integration.example.org/';

async function launchDevice(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  return { context, extensionId: new URL(worker.url()).host };
}

maybe('a bookmark created on device A appears natively on device B after sync', async () => {
  const url = serviceUrl as string;

  // --- Device A: create a bookmark, then create a new sync (which pushes it) ---
  const deviceA = await launchDevice();
  const popupA = await deviceA.context.newPage();
  await popupA.goto(`chrome-extension://${deviceA.extensionId}/popup.html`);

  await popupA.evaluate(
    ([bookmarkUrl]) =>
      (globalThis as unknown as { chrome: ChromeApi }).chrome.bookmarks.create({
        parentId: '1',
        title: 'Integration bookmark',
        url: bookmarkUrl,
      }),
    [BOOKMARK_URL],
  );

  await popupA.fill('#service-url', url);
  await popupA.fill('#password', 'integration-pw');
  await popupA.click('#enable');
  await expect(popupA.locator('#status')).toBeVisible();

  const syncId = (await popupA.locator('#status-sync-id').textContent())?.trim() ?? '';
  expect(syncId).toMatch(/^[a-f0-9]{32}$/);

  // --- Device B: enable the same sync; the bookmark must be applied locally ---
  const deviceB = await launchDevice();
  const popupB = await deviceB.context.newPage();
  await popupB.goto(`chrome-extension://${deviceB.extensionId}/popup.html`);

  await popupB.check('input[name="mode"][value="existing"]');
  await popupB.fill('#service-url', url);
  await popupB.fill('#sync-id', syncId);
  await popupB.fill('#password', 'integration-pw');
  await popupB.click('#enable');
  await expect(popupB.locator('#status')).toBeVisible();

  const matches = await popupB.evaluate(
    async ([bookmarkUrl]) => {
      const results = await (
        globalThis as unknown as { chrome: ChromeApi }
      ).chrome.bookmarks.search({ url: bookmarkUrl });
      return results.length;
    },
    [BOOKMARK_URL],
  );
  expect(matches).toBeGreaterThan(0);

  await deviceA.context.close();
  await deviceB.context.close();
});
