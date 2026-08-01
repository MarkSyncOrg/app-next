import { browser } from 'wxt/browser';
import { renderSyncIdQrSvg, type SyncOutcome, type Theme } from '@marksyncorg/core';
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

/**
 * Ensures the extension may reach the service's origin. The official host is granted
 * at install; custom/self-hosted URLs are covered by an optional host permission that
 * we request here, within the user gesture of submitting the form.
 */
async function ensureHostPermission(serviceUrl: string): Promise<void> {
  let origin: string;
  try {
    origin = `${new URL(serviceUrl).origin}/*`;
  } catch {
    await log.warn('Service URL could not be parsed', { serviceUrl });
    throw new Error('Invalid service URL');
  }
  if (await browser.permissions.contains({ origins: [origin] })) {
    await log.debug('Host permission already granted', { origin });
    return;
  }
  await log.info('Requesting host permission', { origin });
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) {
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

/** Hides the QR code and resets the toggle (e.g. when the displayed sync ID changes). */
function hideQr(): void {
  qrFigure.hidden = true;
  qrCanvas.innerHTML = '';
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
    qrCanvas.innerHTML = await renderSyncIdQrSvg(currentSyncId);
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
  void withBusy('Enable sync', enableButton, async () => {
    const serviceUrl = serviceUrlInput.value.trim();
    const password = passwordInput.value;
    // Never log the password itself — only whether one was entered.
    await log.info('Setup submitted', {
      mode: selectedMode(),
      serviceUrl,
      passwordProvided: password.length > 0,
    });
    await ensureHostPermission(serviceUrl);
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
