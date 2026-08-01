import { browser } from 'wxt/browser';
import {
  backupFilename,
  extractBookmarks,
  parseBackup,
  type Settings,
  type Theme,
} from '@marksyncorg/core';
import { buildDescription, currentBuild, versionLabel } from '../../src/build-info';
import { formatLog } from '../../src/logging/log-entry';
import { createUiLogger } from '../../src/logging/ui-logger';
import type { SyncRequest, SyncResponse, SyncResultData } from '../../src/messaging';

const log = createUiLogger('options');

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

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

const message = el('message');
const themeSelect = el<HTMLSelectElement>('set-theme');
const intervalSelect = el<HTMLSelectElement>('set-interval');
const toolbarCheck = el<HTMLInputElement>('set-toolbar');
const onChangeCheck = el<HTMLInputElement>('set-on-change');
const exportButton = el<HTMLButtonElement>('export-backup');
const importFile = el<HTMLInputElement>('import-file');
const restoreButton = el<HTMLButtonElement>('restore-backup');
const logOutput = el('log-output');

// Rendered up front rather than from init(): the build identity is exactly what a user
// is asked for when something is broken, so it must survive a failing settings load.
const build = currentBuild(browser.runtime.getManifest().version);
const buildInfo = el('build-info');
buildInfo.textContent = versionLabel(build);
buildInfo.title = buildDescription(build);

function showMessage(text: string, isError = false): void {
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = false;
  void log.log(isError ? 'warn' : 'info', `Shown to the user: ${text}`);
}

function applyTheme(theme: Theme): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

/** Triggers a client-side download of text content. */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  void log.debug('Started a file download', { filename, bytes: text.length });
}

// --- Settings ---

function renderSettings(settings: Settings): void {
  themeSelect.value = settings.theme;
  intervalSelect.value = String(settings.syncIntervalMinutes);
  toolbarCheck.checked = settings.syncBookmarksToolbar;
  onChangeCheck.checked = settings.syncOnChange;
  applyTheme(settings.theme);
}

async function saveSettings(update: Partial<Settings>): Promise<void> {
  try {
    await log.info('Saving settings', { changed: update });
    renderSettings(await send({ type: 'setSettings', settings: update }));
  } catch (error) {
    await log.failure('Saving settings failed', error, { changed: update });
    showMessage((error as Error).message || 'Failed to save settings', true);
  }
}

themeSelect.addEventListener('change', () => {
  void saveSettings({ theme: themeSelect.value as Theme });
});
intervalSelect.addEventListener('change', () => {
  void saveSettings({ syncIntervalMinutes: Number(intervalSelect.value) });
});
toolbarCheck.addEventListener('change', () => {
  void saveSettings({ syncBookmarksToolbar: toolbarCheck.checked });
});
onChangeCheck.addEventListener('change', () => {
  void saveSettings({ syncOnChange: onChangeCheck.checked });
});

// --- Backup & restore ---

exportButton.addEventListener('click', () => {
  void (async () => {
    try {
      const backup = await log.operation('Export backup', () => send({ type: 'createBackup' }));
      downloadText(backupFilename(), JSON.stringify(backup, null, 2));
      showMessage('Backup exported.');
    } catch (error) {
      showMessage((error as Error).message || 'Export failed', true);
    }
  })();
});

importFile.addEventListener('change', () => {
  restoreButton.disabled = !importFile.files?.length;
  const file = importFile.files?.[0];
  void log.debug('Backup file selected', { selected: Boolean(file), bytes: file?.size });
});

restoreButton.addEventListener('click', () => {
  void (async () => {
    const file = importFile.files?.[0];
    if (!file) {
      return;
    }
    if (!window.confirm('Restore will replace your current bookmarks. Continue?')) {
      await log.info('Restore cancelled by the user');
      return;
    }
    restoreButton.disabled = true;
    try {
      // Parsing happens here (not in the worker) so a malformed file is reported
      // before anything touches the browser's bookmarks.
      const bookmarks = await log.operation(
        'Parse backup file',
        async () => extractBookmarks(parseBackup(await file.text())),
        { context: { bytes: file.size }, summarise: (parsed) => ({ containers: parsed.length }) },
      );
      await log.operation('Restore backup', () => send({ type: 'restoreBackup', bookmarks }), {
        context: { containers: bookmarks.length },
        successLevel: 'info',
      });
      importFile.value = '';
      showMessage('Backup restored.');
      await loadLog();
    } catch (error) {
      showMessage((error as Error).message || 'Restore failed', true);
    } finally {
      restoreButton.disabled = !importFile.files?.length;
    }
  })();
});

// --- Conflict recovery ---

const forcePullButton = el<HTMLButtonElement>('force-pull');
const forcePushButton = el<HTMLButtonElement>('force-push');

/** Runs a force pull/push with a destructive-action confirm and status feedback. */
async function forceSync(
  type: 'forcePull' | 'forcePush',
  confirmText: string,
  successText: string,
): Promise<void> {
  if (!window.confirm(confirmText)) {
    await log.info('Force sync cancelled by the user', { type });
    return;
  }
  forcePullButton.disabled = true;
  forcePushButton.disabled = true;
  try {
    await log.operation(`Force sync (${type})`, () => send({ type }), { successLevel: 'info' });
    showMessage(successText);
    await loadLog();
  } catch (error) {
    showMessage((error as Error).message || 'Force sync failed', true);
  } finally {
    forcePullButton.disabled = false;
    forcePushButton.disabled = false;
  }
}

forcePullButton.addEventListener('click', () => {
  void forceSync(
    'forcePull',
    "Force pull will replace this device's bookmarks with the server copy. Continue?",
    'Forced pull from server.',
  );
});
forcePushButton.addEventListener('click', () => {
  void forceSync(
    'forcePush',
    "Force push will overwrite the server with this device's bookmarks. Continue?",
    'Forced push to server.',
  );
});

// --- Debug log ---

async function loadLog(): Promise<void> {
  const entries = await send({ type: 'getLog' });
  logOutput.textContent = entries.length ? formatLog(entries) : '(no log entries)';
}

el<HTMLButtonElement>('refresh-log').addEventListener('click', () => {
  void loadLog().catch((error: unknown) => showMessage((error as Error).message, true));
});

el<HTMLButtonElement>('download-log').addEventListener('click', () => {
  void (async () => {
    try {
      const entries = await send({ type: 'getLog' });
      downloadText('xbs_log.txt', formatLog(entries));
    } catch (error) {
      showMessage((error as Error).message || 'Log download failed', true);
    }
  })();
});

el<HTMLButtonElement>('clear-log').addEventListener('click', () => {
  void (async () => {
    try {
      await send({ type: 'clearLog' });
      await loadLog();
    } catch (error) {
      showMessage((error as Error).message || 'Clearing the log failed', true);
    }
  })();
});

// The anchor opens the site by itself; this only keeps the action in the trace.
el<HTMLAnchorElement>('site-link').addEventListener('click', () => {
  void log.debug('Opening the MarkSync website');
});

async function init(): Promise<void> {
  await log.debug('Options page opened');
  renderSettings(await send({ type: 'getSettings' }));
  await loadLog();
}

void init().catch((error: unknown) => {
  void log.failure('Options page failed to load', error);
  showMessage((error as Error).message || 'Failed to load', true);
});
