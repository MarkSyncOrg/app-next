import { test, expect } from './fixtures';

test('background service worker registers with a valid extension id', async ({ extensionId }) => {
  // A Chromium extension id is 32 lowercase letters. Its presence proves the built
  // MV3 background service worker loaded and registered successfully.
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});
