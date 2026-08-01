import { expect, test } from './fixtures';

test('popup shows the setup form when sync is not enabled', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // The setup form is shown only after the popup queries status from the worker,
  // so this also exercises the popup<->background messaging round-trip.
  await expect(page.locator('#setup')).toBeVisible();
  await expect(page.locator('#service-url')).toHaveValue('https://api.xbrowsersync.org');
  await expect(page.locator('#status')).toBeHidden();
});

test('popup stamps the build it was made from', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // The version comes from the manifest and the sha is injected at build time, so a
  // build made from a git checkout shows both.
  await expect(page.locator('#build-info')).toHaveText(
    /^v\d+\.\d+\.\d+( \([0-9a-f]{7}(-dirty)?\))?$/,
  );
});

test('popup links to the MarkSync website', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  // Opened in a new tab: the popup is dismissed as soon as focus leaves it, so
  // navigating in place would lose whatever the user was doing.
  const link = page.locator('#site-link');
  await expect(link).toBeVisible();
  await expect(link).toContainText('Open the MarkSync web app');
  await expect(link).toHaveAttribute('href', 'https://app.marksync.org');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
