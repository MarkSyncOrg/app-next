import { expect, test } from './fixtures';

test('options page renders settings, backup and log sections', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // Settings populate from the worker (getSettings), exercising messaging.
  await expect(page.locator('#set-theme')).toBeVisible();
  await expect(page.locator('#set-interval')).toHaveValue('15');
  await expect(page.locator('#export-backup')).toBeVisible();
  // The log loads from the worker (getLog) and already carries the worker's own
  // startup trace, under the day header written by the daily rotation.
  await expect(page.locator('#log-output')).toContainText('Service worker started');
  await expect(page.locator('#log-output')).toContainText('=====');
  // Build stamp: the manifest version, plus the commit when built from a checkout.
  await expect(page.locator('#build-info')).toHaveText(
    /^v\d+\.\d+\.\d+( \([0-9a-f]{7}(-dirty)?\))?$/,
  );
  // Link out to the MarkSync website, opened in a new tab.
  const link = page.locator('#site-link');
  await expect(link).toBeVisible();
  await expect(link).toContainText('Open the MarkSync web app');
  await expect(link).toHaveAttribute('href', 'https://app.marksync.org');
  await expect(link).toHaveAttribute('target', '_blank');
});

test('log entries from the options page reach the worker log', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // Changing a setting is traced by the page (relayed to the worker) and by the
  // worker itself; refreshing must show both, proving the log relay round-trip.
  // The relay is fire-and-forget, so re-read the log until both lines land.
  await page.selectOption('#set-interval', '30');

  await expect(async () => {
    await page.click('#refresh-log');
    await expect(page.locator('#log-output')).toContainText('[options] Saving settings');
    await expect(page.locator('#log-output')).toContainText('[sync] Settings updated');
  }).toPass();
});

test('the sync direction selector drives the hint and the recovery buttons', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // Two-way by default: nothing is one-way until the user says so.
  await expect(page.locator('#set-direction')).toHaveValue('two-way');
  await expect(page.locator('#direction-hint')).toContainText('sends and receives');
  await expect(page.locator('#force-pull')).toBeEnabled();
  await expect(page.locator('#force-push')).toBeEnabled();

  // Send only: the device never applies the server's tree, so force pull is out.
  await page.selectOption('#set-direction', 'push-only');
  await expect(page.locator('#direction-hint')).toContainText('only sends');
  await expect(page.locator('#force-pull')).toBeDisabled();
  await expect(page.locator('#force-push')).toBeEnabled();

  // Receive only: the mirror never uploads, so force push and sync-on-change are out.
  await page.selectOption('#set-direction', 'pull-only');
  await expect(page.locator('#direction-hint')).toContainText('only receives');
  await expect(page.locator('#force-push')).toBeDisabled();
  await expect(page.locator('#force-pull')).toBeEnabled();
  await expect(page.locator('#set-on-change')).toBeDisabled();

  // The setting is persisted by the worker, not just held in the page.
  await page.reload();
  await expect(page.locator('#set-direction')).toHaveValue('pull-only');
});
