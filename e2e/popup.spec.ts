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

test('popup asks for the host permission inside the submit event', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#setup')).toBeVisible();

  // A custom (self-hosted) service is only reachable once the user grants its origin,
  // and `permissions.request()` is honoured only while the browser is still handling
  // the click that asked for it. Firefox drops that state at the first `await`, so a
  // single log line before the call is enough to make self-hosted setup impossible
  // there. Chrome keeps a transient activation for seconds and would not notice the
  // regression, so rather than checking for a gesture this pins the ordering itself:
  // the request has to land between the capturing and the bubbling listener of the very
  // same submit event, which is only true when nothing is awaited in between.
  const calls = await page.evaluate(() => {
    type PermissionsApi = {
      permissions: { request: (permissions: { origins?: string[] }) => unknown };
    };
    const namespaces = globalThis as unknown as {
      chrome?: PermissionsApi;
      browser?: PermissionsApi;
    };
    const recorded: { origins?: string[]; duringDispatch: boolean }[] = [];
    let dispatching = false;
    window.addEventListener(
      'submit',
      () => {
        dispatching = true;
      },
      true,
    );
    window.addEventListener('submit', () => {
      dispatching = false;
    });
    // Whichever namespace `wxt/browser` resolved to is the one the popup calls, so
    // stub every one this build exposes rather than guessing.
    for (const namespace of [namespaces.chrome, namespaces.browser]) {
      if (!namespace?.permissions) {
        continue;
      }
      namespace.permissions.request = (permissions) => {
        recorded.push({ origins: permissions.origins, duringDispatch: dispatching });
        return Promise.resolve(true);
      };
    }

    const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    el<HTMLInputElement>('service-url').value = 'https://sync.example.invalid';
    el<HTMLInputElement>('password').value = 'a-passphrase';
    el<HTMLButtonElement>('enable').click();
    return recorded;
  });

  expect(calls).toEqual([{ origins: ['https://sync.example.invalid/*'], duringDispatch: true }]);
});
