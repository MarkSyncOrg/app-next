import { browser } from 'wxt/browser';
import { renderSyncIdQrSvg, type SyncOutcome, type Theme } from '@marksyncorg/core';
import { buildDescription, currentBuild, versionLabel } from '../../src/build-info';
import { createUiLogger } from '../../src/logging/ui-logger';
import type { SyncRequest, SyncResponse, SyncResultData } from '../../src/messaging';
import { HostPermissionGate } from '../../src/webext/host-permission';

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

const hostPermissions = new HostPermissionGate(browser.permissions, log);
// The submit handler has to ask for the host permission without awaiting anything first
// (see HostPermissionGate), so the snapshot of what is already granted has to be in
// place before the form can be submitted. Read as the popup opens, independently of the
// status round-trip in init(): a sleeping worker must not keep setup from starting.
enableButton.disabled = true;
void hostPermissions.refresh().finally(() => {
  enableButton.disabled = false;
});

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

/** How long the popup waits for a best-effort service round-trip before giving up. */
const SERVICE_REQUEST_TIMEOUT_MS = 8000;

/**
 * Bumped once per render, so a response that arrives after a later render has already
 * repainted (or after sync was disabled) is discarded instead of overwriting it.
 */
let renderGeneration = 0;

async function render(): Promise<void> {
  const status = await send({ type: 'getStatus' });
  await log.debug('Rendering status', {
    enabled: status.enabled,
    lastUpdated: status.lastUpdated,
  });
  setupForm.hidden = status.enabled;
  statusView.hidden = !status.enabled;

  if (status.enabled) {
    el('status-service-url').textContent = status.serviceUrl ?? '';
    el('status-sync-id').textContent = status.syncId ?? '';
    el('status-last-updated').textContent = formatTimestamp(status.lastUpdated);
    currentSyncId = status.syncId ?? '';
    hideQr();

    // Deliberately not awaited: these are best-effort network round-trips, and every
    // caller of render() runs inside withBusy, so awaiting them here would keep the
    // button that triggered the render disabled until the service decides to answer.
    renderGeneration += 1;
    void refreshServicePanels(status.serviceUrl, renderGeneration);
  }
}

/**
 * Rejects if `promise` has not settled in time. The request itself is not cancellable
 * from the popup, but the panel waiting on it stops hanging: a service that accepts the
 * connection and then never answers would otherwise leave the badge and the usage bar
 * pending for as long as the popup stays open.
 */
function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), SERVICE_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, expiry]).finally(() => {
    clearTimeout(timer);
  });
}

/** Fills in the service badge, operator message and data-usage bar for one render. */
async function refreshServicePanels(
  serviceUrl: string | undefined,
  generation: number,
): Promise<void> {
  const maxSyncSize = serviceUrl ? await renderServiceHealth(serviceUrl, generation) : undefined;
  if (generation === renderGeneration) {
    await renderDataUsage(maxSyncSize, generation);
  }
}

const SERVICE_STATUS_BADGE: Record<number, { symbol: string; className: string; label: string }> = {
  1: { symbol: '✓', className: 'badge-online', label: 'Online' },
  2: { symbol: '✕', className: 'badge-offline', label: 'Offline' },
  3: { symbol: '⚠', className: 'badge-limited', label: 'Online, not accepting new syncs' },
};

/**
 * Fetches the service's status/version/operator message and renders them next to the
 * service URL. Best-effort: a service that can't be reached just hides the badge and
 * message rather than failing the whole status view.
 */
async function renderServiceHealth(
  serviceUrl: string,
  generation: number,
): Promise<number | undefined> {
  const badge = el('status-service-badge');
  const messageEl = el('service-message');
  try {
    const info = await withTimeout(send({ type: 'getServiceInfo', serviceUrl }), 'Service info');
    if (generation !== renderGeneration) {
      return undefined;
    }
    const known = SERVICE_STATUS_BADGE[info.status];
    const label = known?.label ?? `Unknown status (${info.status})`;
    badge.textContent = known?.symbol ?? '?';
    badge.title = label;
    // The glyph and its colour are the only visual cue, so the state has to be spelled
    // out for assistive technology as well (the span is role="img" in the markup).
    badge.setAttribute('aria-label', label);
    badge.className = `badge ${known?.className ?? ''}`;
    badge.hidden = false;

    if (info.message) {
      messageEl.replaceChildren(renderServiceMessage(info.message));
      messageEl.hidden = false;
    } else {
      messageEl.hidden = true;
    }
    return info.maxSyncSize;
  } catch (error) {
    await log.debug('Could not fetch service info', { errorMessage: (error as Error).message });
    if (generation === renderGeneration) {
      badge.hidden = true;
      messageEl.hidden = true;
    }
    return undefined;
  }
}

/**
 * Fetches how much of the sync's storage quota is used and renders the usage bar.
 * Best-effort, same as {@link renderServiceHealth}: hidden rather than shown broken.
 */
async function renderDataUsage(maxSyncSize: number | undefined, generation: number): Promise<void> {
  const container = el('data-usage');
  if (maxSyncSize === undefined || maxSyncSize <= 0) {
    container.hidden = true;
    return;
  }
  try {
    const { usedBytes } = await withTimeout(send({ type: 'getSyncUsage' }), 'Sync data usage');
    if (generation !== renderGeneration) {
      return;
    }
    const percent = Math.min(100, Math.round((usedBytes / maxSyncSize) * 100));
    el('data-usage-percent').textContent = `${percent}%`;
    el('data-usage-fill').style.width = `${percent}%`;
    el('data-usage-detail').textContent =
      `${formatBytes(usedBytes)} of ${formatBytes(maxSyncSize)}`;
    container.hidden = false;
  } catch (error) {
    await log.debug('Could not fetch sync data usage', { errorMessage: (error as Error).message });
    if (generation === renderGeneration) {
      container.hidden = true;
    }
  }
}

/** Formats a byte count as a short human-readable size (e.g. "77 KB", "1.2 MB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

/**
 * Whether a value is safe to use as a link href (only ever an absolute http/https URL).
 *
 * Parsed with no base URL on purpose: resolving against one would accept a relative
 * (`/foo`) or protocol-relative (`//host/x`) href, which the anchor would then resolve
 * against the popup's own `chrome-extension://` origin — pointing back inside the
 * extension rather than at the service operator's site.
 */
function isSafeHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/** Elements the service operator message is allowed to use once sanitised. */
const MESSAGE_ALLOWED_TAGS = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'BR', 'SPAN', 'P']);

/**
 * Copies `source`'s children into `target`, dropping any element that is not on the
 * small allowlist (unwrapping it to keep its safe text/descendants) and, for the
 * elements that are kept, stripping every attribute except a validated `href` on `<a>`.
 * Recurses instead of using `innerHTML`, so nothing in the source — event handlers,
 * `javascript:` URLs, `style` attributes — can execute once adopted into the popup.
 */
function appendSanitised(source: Node, target: Node): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.textContent ?? ''));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = child as Element;
    const isLink = element.tagName === 'A';
    const href = isLink ? (element.getAttribute('href') ?? '') : '';
    // Unwrap anything off the allowlist, and any link we would refuse to give an href
    // to — an anchor without one renders as inert text, so keep the contents and drop
    // the element itself.
    if (!MESSAGE_ALLOWED_TAGS.has(element.tagName) || (isLink && !isSafeHttpUrl(href))) {
      appendSanitised(element, target);
      return;
    }
    const clean = document.createElement(element.tagName.toLowerCase());
    if (isLink) {
      clean.setAttribute('href', href);
      clean.setAttribute('target', '_blank');
      clean.setAttribute('rel', 'noopener noreferrer');
    }
    appendSanitised(element, clean);
    target.appendChild(clean);
  });
}

/**
 * Sanitises the service operator message. The API only strips `<script>` tags
 * server-side, so this is otherwise-untrusted HTML from whichever service the user
 * pointed the extension at — parsed into an inert document and reduced to a small
 * safe subset before it ever joins the popup's DOM (see {@link appendSanitised}).
 */
function renderServiceMessage(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fragment = document.createDocumentFragment();
  appendSanitised(parsed.body, fragment);
  return fragment;
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
  // Asked for here rather than inside the async action below: Firefox only accepts
  // permissions.request() while it is still handling this submit event, and everything
  // in withBusy() — including the first log line — resolves in a later task. The result
  // is awaited there, so a denial still surfaces as an error message.
  const permission = hostPermissions.ensure(serviceUrl);
  void withBusy('Enable sync', enableButton, async () => {
    const password = passwordInput.value;
    // Never log the password itself — only whether one was entered.
    await log.info('Setup submitted', {
      mode: selectedMode(),
      serviceUrl,
      passwordProvided: password.length > 0,
    });
    await permission;
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

el<HTMLAnchorElement>('public-servers-link').addEventListener('click', () => {
  void log.debug('Opening the public sync servers list');
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
