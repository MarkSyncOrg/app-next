import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Path to the built Chromium extension. Run `npm run build` before the e2e tests.
const extensionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.output/chrome-mv3',
);

// Playwright fixtures that load the built extension into a persistent Chromium
// context and expose its generated extension ID.
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures object as the first arg
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker');
    }
    // chrome-extension://<id>/background.js -> host is the extension id
    const extensionId = new URL(worker.url()).host;
    await use(extensionId);
  },
});

export const expect = test.expect;
