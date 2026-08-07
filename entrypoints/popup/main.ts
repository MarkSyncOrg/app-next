import { browser } from 'wxt/browser';
import {
  normalizeServiceUrl,
  renderSyncIdQrSvg,
  type SyncOutcome,
  type Theme,
} from '@marksyncorg/core';
import { buildDescription, currentBuild, versionLabel } from '../../src/build-info';
import { createUiLogger } from '../../src/logging/ui-logger';
import type { SyncRequest, SyncResponse, SyncResultData } from '../../src/messaging';

const SYNC_OUTCOME_MESSAGES: Record<SyncOutcome, string> = {
  idle: 'Already up to date.',
  pushed: 'Pushed local changes.',
  pulled: 'Pulled latest changes.',
  merged: 'Merged local and remote changes.',
};

const log = createUiLogger('popup');

/** Sends a typed request to the background worker and unwraps the response. */
async function send<K extends SyncRequest['type']>(
  request: Extract<SyncRequest, { type: K }>,
): Promise<SyncResultData[K]> {
  const response = (await browser.runtime.sendMessage(request)) as SyncResponse<SyncResultData[K]>;
  if (!response.ok) {
    await log.warn('Request rejected by the worker', {
      request: request.type,
      errorName: response.error.name,
      errorMessage: response.error.message,
    });
    const error = new Error(response.error.message);
    error.name = response.error.name;
    throw error;
  }
  return response.data;
}

/** A host permission request already in flight, started inside a user gesture. */
interface PendingHostPermission {
  /** The match pattern asked for, e.g. `https://sync.example.org/*`. */
  origin: string;
  /** Settles with the user's answer (true when the origin is granted). */
  granted: Promise<boolean>;
}

/**
 * Asks the browser to grant the service's origin — and does it *now*, synchronously.
 *
 * `permissions.request()` may only be called while the browser is still handling the
 * user input that led to it, and Firefox drops that state at the very first `await`:
 * anything asynchronous in between (a log line, or even `permissions.contains()`) makes
 * the call throw "permissions.request may only be called from a user input handler".
 * Chrome keeps a transient activation for a few seconds, which is why this only ever
 * failed on Firefox — and only for custom services, since the official host is granted
 * at install and never reached the request. The whole function therefore stays
 * synchronous and hands the pending promise back for the async flow to await; the
 * logging lives in {@link ensureHostPermission}, after the request is already out.
 *
 * For the same reason there is no `permissions.contains()` pre-check, and none is
 * needed: requesting an origin the extension already holds resolves true without
 * prompting the user.
 *
 * The URL is put through core's `normalizeServiceUrl`, which is the same check the API
 * client applies before every request: HTTPS (bar loopback), no query, no fragment, no
 * embedded credentials. Running it here means a bad URL is refused with a readable
 * message before the browser is asked for a host permission, rather than a round trip
 * later — and there is one definition of a valid service URL, not two. It throws
 * synchronously, so the caller reports the bad URL without starting the flow.
 */
function requestHostPermission(serviceUrl: string): PendingHostPermission {
  const origin = `${new URL(normalizeServiceUrl(serviceUrl)).origin}/*`;
  const granted = browser.permissions.request({ origins: [origin] });
  // The submit flow only awaits this a few ticks from now (it logs first). Attaching a
  // handler here keeps an immediate rejection from being reported as an unhandled one
  // in the meantime; the promise still rejects for the awaiting caller.
  granted.catch(() => {});
  return { origin, granted };
}

/** Waits for a pending host permission request and records how it went. */
async function ensureHostPermission({ origin, granted }: PendingHostPermission): Promise<void> {
  await log.info('Requested host permission', { origin });
  if (!(await granted)) {
    await log.warn('Host permission denied by the user', { origin });
    throw new Error('Permission to access this service was denied');
  }
  await log.info('Host permission granted', { origin });
}

/** Returns a required element by ID, narrowing to the expected type. */
function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

const message = el('message');
const setupForm = el<HTMLFormElement>('setup');
const statusView = el('status');
const serviceUrlInput = el<HTMLInputElement>('service-url');
const syncIdField = el('sync-id-field');
const syncIdInput = el<HTMLInputElement>('sync-id');
const passwordInput = el<HTMLInputElement>('password');
const enableButton = el<HTMLButtonElement>('enable');

// Rendered up front rather than from init(): the build identity is exactly what a user
// is asked for when something is broken, so it must survive a failing status request.
const build = currentBuild(browser.runtime.getManifest().version);
const buildInfo = el('build-info');
buildInfo.textContent = versionLabel(build);
buildInfo.title = buildDescription(build);

/** Applies the chosen theme to the popup (system theme = follow OS). */
function applyTheme(theme: Theme): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function showMessage(text: string, isError = false): void {
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = false;
  // The sync ID is echoed to the user after setup; keep it out of the message log.
  void log.log(isError ? 'warn' : 'info', 'Shown to the user', { chars: text.length });
}

function clearMessage(): void {
  message.hidden = true;
}

function selectedMode(): 'new' | 'existing' {
  const checked = setupForm.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'existing' ? 'existing' : 'new';
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) {
    return 'never';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** The sync ID currently displayed, used to render its QR code on demand. */
let currentSyncId = '';

async function render(): Promise<void> {
  const status = await send({ type: 'getStatus' });
  await log.debug('Rendering status', {
    enabled: status.enabled,
    lastUpdated: status.lastUpdated,
  });
  setupForm.hidden = status.enabled;
  statusView.hidden = !status.enabled;

  if (status.enabled) {
    el('status-service').textContent = status.serviceUrl ?? '';
    el('status-sync-id').textContent = status.syncId ?? '';
    el('status-last-updated').textContent = formatTimestamp(status.lastUpdated);
    currentSyncId = status.syncId ?? '';
    hideQr();
  }
}

const qrFigure = el('qr');
const qrCanvas = el('qr-canvas');
const toggleQrButton = el<HTMLButtonElement>('toggle-qr');

/**
 * Turns SVG markup into a live element without going through `innerHTML`: the string is
 * parsed as XML into an inert document, so nothing in it runs at parse time, anything
 * executable is dropped, and only then is the `<svg>` root adopted into the popup.
 * Assigning markup to `innerHTML` is also what the AMO validator flags as unsafe.
 */
function parseSvg(markup: string): Element {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('The QR code could not be rendered');
  }
  // Defence in depth: the markup is generated locally from the sync ID, but a QR code
  // has no use for scripting, so nothing executable joins the document.
  parsed.querySelectorAll('script, foreignObject').forEach((node) => {
    node.remove();
  });
  parsed.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const isEventHandler = name.startsWith('on');
      // `<a href="javascript:…">` inside an SVG stays clickable once adopted.
      const isScriptUrl =
        (name === 'href' || name.endsWith(':href')) &&
        attribute.value.trim().toLowerCase().startsWith('javascript:');
      if (isEventHandler || isScriptUrl) {
        element.removeAttributeNode(attribute);
      }
    }
  });
  return document.importNode(root, true);
}

/** Hides the QR code and resets the toggle (e.g. when the displayed sync ID changes). */
function hideQr(): void {
  qrFigure.hidden = true;
  qrCanvas.replaceChildren();
  toggleQrButton.textContent = 'Show QR code';
  toggleQrButton.setAttribute('aria-expanded', 'false');
}

toggleQrButton.addEventListener('click', () => {
  if (!qrFigure.hidden) {
    void log.debug('Hiding the sync ID QR code');
    hideQr();
    return;
  }
  void withBusy('Show QR code', toggleQrButton, async () => {
    qrCanvas.replaceChildren(parseSvg(await renderSyncIdQrSvg(currentSyncId)));
    qrFigure.hidden = false;
    toggleQrButton.textContent = 'Hide QR code';
    toggleQrButton.setAttribute('aria-expanded', 'true');
  });
});

/**
 * Runs an async action with a busy button and unified error handling, tracing the
 * action (start, duration, failure) so every popup interaction is in the debug log.
 */
async function withBusy(
  name: string,
  button: HTMLButtonElement,
  action: () => Promise<void>,
): Promise<void> {
  button.disabled = true;
  try {
    await log.operation(name, action);
  } catch (error) {
    showMessage((error as Error).message || 'Something went wrong', true);
  } finally {
    button.disabled = false;
  }
}

setupForm.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    syncIdField.hidden = selectedMode() !== 'existing';
    void log.debug('Setup mode changed', { mode: selectedMode() });
  });
});

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMessage();
  const serviceUrl = serviceUrlInput.value.trim();
  const password = passwordInput.value;
  // Fired here rather than inside the async flow below: the browser only honours a
  // permission request while it is still handling this submit event, so nothing may be
  // awaited before it. See requestHostPermission.
  let pending: PendingHostPermission;
  try {
    pending = requestHostPermission(serviceUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Invalid service URL';
    void log.warn('Refused an unusable service URL', { serviceUrl, errorMessage: reason });
    showMessage(reason, true);
    return;
  }
  void withBusy('Enable sync', enableButton, async () => {
    // Never log the password itself — only whether one was entered.
    await log.info('Setup submitted', {
      mode: selectedMode(),
      serviceUrl,
      passwordProvided: password.length > 0,
    });
    await ensureHostPermission(pending);
    if (selectedMode() === 'new') {
      const { syncId } = await send({ type: 'enableNewSync', serviceUrl, password });
      showMessage(`Sync created. Save this sync ID to add other devices: ${syncId}`);
    } else {
      await send({
        type: 'enableExistingSync',
        serviceUrl,
        syncId: syncIdInput.value.trim(),
        password,
      });
      showMessage('Sync enabled.');
    }
    passwordInput.value = '';
    await render();
  });
});

el<HTMLButtonElement>('sync-now').addEventListener('click', () => {
  const button = el<HTMLButtonElement>('sync-now');
  clearMessage();
  void withBusy('Sync now', button, async () => {
    const { outcome } = await send({ type: 'sync' });
    showMessage(SYNC_OUTCOME_MESSAGES[outcome]);
    await render();
  });
});

el<HTMLButtonElement>('disable').addEventListener('click', () => {
  const button = el<HTMLButtonElement>('disable');
  clearMessage();
  void withBusy('Disable sync', button, async () => {
    await send({ type: 'disable' });
    showMessage('Sync disabled.');
    await render();
  });
});

el<HTMLButtonElement>('open-options').addEventListener('click', () => {
  void log.debug('Opening the options page');
  void browser.runtime.openOptionsPage();
});

// The anchor opens the site by itself; this only keeps the action in the trace.
el<HTMLAnchorElement>('site-link').addEventListener('click', () => {
  void log.debug('Opening the MarkSync website');
});

async function init(): Promise<void> {
  await log.debug('Popup opened');
  const settings = await send({ type: 'getSettings' });
  applyTheme(settings.theme);
  await render();
}

void init().catch((error: unknown) => {
  void log.failure('Popup failed to load', error);
  showMessage((error as Error).message || 'Failed to load', true);
});
