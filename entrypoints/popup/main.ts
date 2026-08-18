import { browser } from 'wxt/browser';
import {
  DESCRIPTION_MAX_LENGTH,
  formatTags,
  isSafeBookmarkUrl,
  normalizeDescription,
  parseTags,
  renderSyncIdQrSvg,
  type SyncDirection,
  type SyncOutcome,
  type Theme,
} from '@marksyncorg/core';
import { buildDescription, currentBuild, versionLabel } from '../../src/build-info';
import { createUiLogger } from '../../src/logging/ui-logger';
import { type SetupMode, setupDirectionHint } from '../../src/setup-direction';
import type { SyncRequest, SyncResponse, SyncResultData } from '../../src/messaging';
import { HostPermissionGate } from '../../src/webext/host-permission';
import { readPageMetadata } from '../../src/webext/page-metadata';

const SYNC_OUTCOME_MESSAGES: Record<SyncOutcome, string> = {
  idle: 'Already up to date.',
  pushed: 'Pushed local changes.',
  pulled: 'Pulled latest changes.',
  merged: 'Merged local and remote changes.',
  skipped: 'Remote changes ignored: this device only sends.',
  reverted: 'Local changes undone: this device only receives.',
};

/**
 * How a one-way device describes itself in the status view. Two-way is the default and
 * gets no row: only a device that deliberately refuses half the sync needs to say so,
 * and it is the explanation for an "Update Sync" that sent or applied nothing.
 */
const DIRECTION_LABELS: Partial<Record<SyncDirection, string>> = {
  'push-only': 'Send only — remote changes are not applied here',
  'pull-only': 'Receive only — local changes are not uploaded',
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
const setupModeSelect = el<HTMLSelectElement>('setup-mode');
const setupDirectionSelect = el<HTMLSelectElement>('setup-direction');
const setupDirectionHintText = el('setup-direction-hint');

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

function selectedMode(): SetupMode {
  return setupModeSelect.value === 'existing' ? 'existing' : 'new';
}

function selectedSetupDirection(): SyncDirection {
  return setupDirectionSelect.value as SyncDirection;
}

/** Repaints the setup hint for the current mode/direction pair. */
function renderSetupDirectionHint(): void {
  const hint = setupDirectionHint(selectedMode(), selectedSetupDirection());
  setupDirectionHintText.textContent = hint ?? '';
  setupDirectionHintText.hidden = hint === null;
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
    direction: status.direction,
  });
  setupForm.hidden = status.enabled;
  statusView.hidden = !status.enabled;

  if (status.enabled) {
    el('status-service-url').textContent = status.serviceUrl ?? '';
    el('status-sync-id').textContent = status.syncId ?? '';
    el('status-last-updated').textContent = formatTimestamp(status.lastUpdated);
    const directionLabel = DIRECTION_LABELS[status.direction];
    el('status-direction-row').hidden = directionLabel === undefined;
    el('status-direction').hidden = directionLabel === undefined;
    el('status-direction').textContent = directionLabel ?? '';
    currentSyncId = status.syncId ?? '';
    hideQr();
    await renderPageMeta();

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

/* ---- Description and tags for the active tab ------------------------------------- */

const pageMetaForm = el<HTMLFormElement>('page-meta');
const pageMetaTitle = el('page-meta-title');
const pageMetaHint = el('page-meta-hint');
const pageDescription = el<HTMLTextAreaElement>('page-description');
const pageDescriptionCount = el('page-description-count');
const pageTags = el<HTMLInputElement>('page-tags');
const pageMetaSave = el<HTMLButtonElement>('page-meta-save');

// The model trims a longer description at a word boundary, so a hard cap here keeps the
// field honest: what the user types is what gets stored.
pageDescription.maxLength = DESCRIPTION_MAX_LENGTH;

/** The active tab's URL and title, once the editor has resolved them. */
interface ActivePage {
  url: string;
  title: string;
  tabId?: number;
}

let activePage: ActivePage | undefined;
/** Whether the active page is already bookmarked, which decides what saving does. */
let activePageBookmarked = false;

/**
 * The page in the active tab, or undefined when there is nothing bookmarkable there.
 *
 * The URL and title are only readable because of the `activeTab` permission, which the
 * browser grants for the tab the user was on when they opened the popup — and only for
 * as long as it is open. That is why the extension can offer this without asking for
 * access to browsing history.
 */
async function readActivePage(): Promise<ActivePage | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  // isSafeBookmarkUrl is the same check the sync applies, so the editor appears exactly
  // when the page could actually be synced — never on about:/chrome:// pages, the
  // extension's own pages, or anything else the sync would refuse to carry.
  if (!url || !isSafeBookmarkUrl(url)) {
    return undefined;
  }
  return { url, title: tab.title ?? url, tabId: tab.id };
}

/** Updates the character counter under the description field. */
function renderDescriptionCount(): void {
  const used = pageDescription.value.length;
  pageDescriptionCount.textContent = `${used} / ${DESCRIPTION_MAX_LENGTH} characters`;
}

pageDescription.addEventListener('input', renderDescriptionCount);

/**
 * Fills in the editor for the active tab, or hides it when the page cannot be
 * bookmarked. Best-effort, like the service panels: a failure here must not take the
 * sync status down with it.
 */
async function renderPageMeta(): Promise<void> {
  try {
    activePage = await readActivePage();
    if (!activePage) {
      pageMetaForm.hidden = true;
      await log.debug('No bookmarkable page in the active tab');
      return;
    }

    const meta = await send({ type: 'getBookmarkMetadata', url: activePage.url });
    activePageBookmarked = meta.bookmarked;
    pageMetaTitle.textContent = meta.title ?? activePage.title;
    pageMetaTitle.title = activePage.url;
    pageDescription.value = meta.description ?? '';
    pageTags.value = formatTags(meta.tags);
    renderDescriptionCount();

    pageMetaSave.textContent = meta.bookmarked ? 'Save' : 'Add bookmark';
    // Two things are worth saying out loud, and only one can ever apply: that saving
    // will create the bookmark, or that the page is bookmarked more than once and every
    // copy gets the same description and tags.
    if (!meta.bookmarked) {
      pageMetaHint.textContent = 'Not bookmarked yet — saving adds it to your other bookmarks.';
      pageMetaHint.hidden = false;
    } else if (meta.matches > 1) {
      pageMetaHint.textContent = `Bookmarked ${meta.matches} times; all copies will be updated.`;
      pageMetaHint.hidden = false;
    } else {
      pageMetaHint.hidden = true;
    }
    pageMetaForm.hidden = false;
    await suggestFromPage();
  } catch (error) {
    await log.debug('Could not load the page editor', {
      errorMessage: (error as Error).message,
    });
    pageMetaForm.hidden = true;
  }
}

/**
 * Fills empty fields with what the page says about itself.
 *
 * Only ever fills a field that is empty, so nothing the sync carries — or the user
 * typed — is overwritten by a page's own claims about itself. Nothing is stored either:
 * this is a suggestion sitting in the form until the user saves it, which is why the
 * hint says so rather than letting them think it is already recorded.
 */
async function suggestFromPage(): Promise<void> {
  const page = activePage;
  const wantDescription = pageDescription.value === '';
  const wantTags = pageTags.value === '';
  if (!page || (!wantDescription && !wantTags)) {
    return;
  }

  const metadata = await readPageMetadata(page.tabId);
  const description = wantDescription ? normalizeDescription(metadata.description) : '';
  const tags = wantTags ? parseTags(metadata.tags ?? '') : [];
  if (description === '' && tags.length === 0) {
    return;
  }

  if (description !== '') {
    pageDescription.value = description;
    renderDescriptionCount();
  }
  if (tags.length > 0) {
    pageTags.value = formatTags(tags);
  }
  pageMetaHint.textContent = pageMetaHint.hidden
    ? 'Suggested from the page — save to keep.'
    : `${pageMetaHint.textContent} Suggested from the page — save to keep.`;
  pageMetaHint.hidden = false;
  await log.debug('Suggested metadata from the page', {
    descriptionChars: description.length,
    tags: tags.length,
  });
}

pageMetaForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMessage();
  const page = activePage;
  if (!page) {
    return;
  }
  void withBusy('Save page metadata', pageMetaSave, async () => {
    // Normalised before sending, so what leaves the popup is already what will be
    // stored; the worker normalises again because it must not trust its callers.
    const tags = parseTags(pageTags.value);
    const description = pageDescription.value.trim();
    if (activePageBookmarked) {
      await send({ type: 'setBookmarkMetadata', url: page.url, description, tags });
      showMessage('Saved.');
    } else {
      await send({ type: 'addBookmark', url: page.url, title: page.title, description, tags });
      showMessage('Bookmark added.');
    }
    await renderPageMeta();
  });
});

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

setupModeSelect.addEventListener('change', () => {
  syncIdField.hidden = selectedMode() !== 'existing';
  renderSetupDirectionHint();
  void log.debug('Setup mode changed', { mode: selectedMode() });
});

setupDirectionSelect.addEventListener('change', () => {
  renderSetupDirectionHint();
  void log.debug('Setup direction changed', { direction: selectedSetupDirection() });
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
    const direction = selectedSetupDirection();
    await log.info('Setup submitted', {
      mode: selectedMode(),
      serviceUrl,
      passwordProvided: password.length > 0,
      direction,
    });
    await permission;
    if (selectedMode() === 'new') {
      const { syncId } = await send({ type: 'enableNewSync', serviceUrl, password, direction });
      showMessage(`Sync created. Save this sync ID to add other devices: ${syncId}`);
    } else {
      await send({
        type: 'enableExistingSync',
        serviceUrl,
        syncId: syncIdInput.value.trim(),
        password,
        direction,
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

// Painted from the HTML defaults as the popup opens, so the form never shows an empty
// hint while init() waits on the worker.
renderSetupDirectionHint();

async function init(): Promise<void> {
  await log.debug('Popup opened');
  const settings = await send({ type: 'getSettings' });
  applyTheme(settings.theme);
  // Offer the direction this device already had: after a disable, the previous choice is
  // still the one the user means, and setup is where they would otherwise re-pick it.
  setupDirectionSelect.value = settings.syncDirection;
  renderSetupDirectionHint();
  await render();
}

void init().catch((error: unknown) => {
  void log.failure('Popup failed to load', error);
  showMessage((error as Error).message || 'Failed to load', true);
});
