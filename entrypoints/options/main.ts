import { browser } from 'wxt/browser';
import {
  backupFilename,
  extractBookmarksWithReport,
  parseBackup,
  type Settings,
  type SyncDirection,
  type Theme,
} from '@marksyncorg/core';
import { buildDescription, currentBuild, versionLabel } from '../../src/build-info';
import { formatLog } from '../../src/logging/log-entry';
import { createUiLogger } from '../../src/logging/ui-logger';
import { applyTheme } from '../../src/theme';
import type { SyncRequest, SyncResponse, SyncResultData } from '../../src/messaging';

const log = createUiLogger('options');

/**
 * What the sync carries beyond the default set, as the page last saw it.
 *
 * The restore below parses the backup file here rather than in the worker, so it needs
 * the same URL policy the engine will apply: a user who syncs bookmarklets restores them
 * too, and one who does not never writes an executable URL into their bookmarks by
 * restoring a file someone sent them.
 */
let urlPolicy = { allowBookmarklets: false };

/**
 * What each direction does, in the user's terms. Shown under the selector because the
 * option labels alone do not say what happens to changes made on the losing side.
 */
const DIRECTION_HINTS: Record<SyncDirection, string> = {
  'two-way': 'This device sends and receives. Changes made here and elsewhere are merged together.',
  'push-only':
    'This device only sends. Its bookmarks are uploaded, and changes made on other devices are ' +
    'never applied here — they are replaced the next time this device uploads.',
  'pull-only':
    'This device only receives. It mirrors the sync, and changes made here are never uploaded — ' +
    'they are undone the next time it syncs.',
};

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
const intervalSelect = el<HTMLSelectElement>('set-interval');
const toolbarCheck = el<HTMLInputElement>('set-toolbar');
const onChangeCheck = el<HTMLInputElement>('set-on-change');
const bookmarkletCheck = el<HTMLInputElement>('set-bookmarklets');
const bookmarkletHint = el('bookmarklet-hint');
const directionSelect = el<HTMLSelectElement>('set-direction');
const directionHint = el('direction-hint');
const exportButton = el<HTMLButtonElement>('export-backup');
const importFile = el<HTMLInputElement>('import-file');
const importFileLabel = el('import-file-label');
const restoreButton = el<HTMLButtonElement>('restore-backup');
const logOutput = el('log-output');
const themeButtons = [...document.querySelectorAll<HTMLButtonElement>('.segment[data-theme]')];
const themeHint = el('theme-hint');

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
  renderTheme(settings.theme);
  intervalSelect.value = String(settings.syncIntervalMinutes);
  toolbarCheck.checked = settings.syncBookmarksToolbar;
  onChangeCheck.checked = settings.syncOnChange;
  bookmarkletCheck.checked = settings.syncBookmarklets;
  urlPolicy = { allowBookmarklets: settings.syncBookmarklets };
  renderBookmarkletHint();
  directionSelect.value = settings.syncDirection;
  directionHint.textContent = DIRECTION_HINTS[settings.syncDirection];
  // "Sync changes automatically" pushes, so it does nothing on a receive-only device.
  onChangeCheck.disabled = settings.syncDirection === 'pull-only';
  applyDirectionToRecovery(settings.syncDirection);
}

/**
 * Explains the bookmarklet option, and says how many local bookmarks the device is
 * currently keeping out of the sync.
 *
 * The count is what makes the exclusion honest: without it a user whose bookmarklets
 * never reach their other devices has nothing to go on. It is asked for after the text
 * is in place, so a worker that cannot answer leaves the explanation standing.
 */
function renderBookmarkletHint(): void {
  const explanation = bookmarkletCheck.checked
    ? 'Bookmarklets (javascript: and data: addresses) are uploaded with everything else. ' +
      'They run whatever they contain when opened, so anyone who can write this sync can ' +
      'put one in your bookmarks. Turn it on everywhere: a device that has it off removes ' +
      'them from the sync the next time it uploads.'
    : 'Bookmarklets (javascript: and data: addresses) stay on this device: they run whatever ' +
      'they contain when opened, so they are not uploaded unless you ask. Everything else, ' +
      'including chrome://, about: and file:// bookmarks, is synced.';
  bookmarkletHint.textContent = explanation;
  void showExcludedCount(explanation);
}

/**
 * Adds "N bookmark(s) … are not being synced" to the hint, best-effort.
 *
 * Rebuilds the whole sentence from `explanation` rather than appending to what the
 * element holds, so two renders racing each other cannot leave the count in twice, and a
 * late answer to a superseded render is discarded rather than pasted onto the new text.
 */
async function showExcludedCount(explanation: string): Promise<void> {
  try {
    const { count } = await send({ type: 'getExcludedBookmarks' });
    if (count > 0 && bookmarkletHint.textContent === explanation) {
      bookmarkletHint.textContent = `${explanation} ${count} bookmark(s) on this device are not being synced.`;
    }
  } catch (error) {
    await log.debug('Could not count the bookmarks held back from the sync', {
      errorMessage: (error as Error).message,
    });
  }
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

intervalSelect.addEventListener('change', () => {
  void saveSettings({ syncIntervalMinutes: Number(intervalSelect.value) });
});
toolbarCheck.addEventListener('change', () => {
  void saveSettings({ syncBookmarksToolbar: toolbarCheck.checked });
});
onChangeCheck.addEventListener('change', () => {
  void saveSettings({ syncOnChange: onChangeCheck.checked });
});
bookmarkletCheck.addEventListener('change', () => {
  void saveSettings({ syncBookmarklets: bookmarkletCheck.checked });
});
directionSelect.addEventListener('change', () => {
  void saveSettings({ syncDirection: directionSelect.value as SyncDirection });
});

/**
 * Paints the segmented control and the page itself. Applying the theme here rather than
 * only on save means the page follows the setting whichever way it changed — including a
 * save that the worker rejected, which leaves the old value in place.
 */
function renderTheme(theme: Theme): void {
  applyTheme(theme);
  for (const button of themeButtons) {
    button.setAttribute('aria-checked', String(button.dataset.theme === theme));
  }
  // 'light' and 'dark' say what they do; only 'system' needs to name what it follows.
  themeHint.textContent = theme === 'system' ? 'Follows your browser' : '';
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const theme = button.dataset.theme as Theme;
    // Repaint before the round-trip: the theme is a purely local preference, so waiting
    // on the worker would leave the click looking ignored.
    renderTheme(theme);
    void saveSettings({ theme });
  });
}

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
  importFileLabel.textContent = file?.name ?? 'No file selected';
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
      // before anything touches the browser's bookmarks. `extractBookmarksWithReport`
      // validates the shape and drops nodes this device will not carry (a backup file
      // is the least trusted input in the system) and hands back what it dropped, which
      // a restore cannot recover from the tree alone. The policy is the device's own, so
      // the file is filtered exactly as the engine is about to filter the result.
      const { bookmarks, removed } = await log.operation(
        'Parse backup file',
        async () => extractBookmarksWithReport(parseBackup(await file.text()), urlPolicy),
        {
          context: { bytes: file.size },
          summarise: (parsed) => ({
            containers: parsed.bookmarks.length,
            removed: parsed.removed.length,
          }),
        },
      );
      if (removed.length > 0) {
        // Count only: the removed entries carry the titles and URLs the log must not.
        await log.warn('Dropped bookmarks this device does not sync from the backup', {
          removed: removed.length,
          allowBookmarklets: urlPolicy.allowBookmarklets,
        });
      }
      await log.operation('Restore backup', () => send({ type: 'restoreBackup', bookmarks }), {
        context: { containers: bookmarks.length },
        successLevel: 'info',
      });
      importFile.value = '';
      importFileLabel.textContent = 'No file selected';
      showMessage(
        removed.length > 0
          ? `Backup restored. ${removed.length} bookmark(s) with an address this device does not ` +
              'sync were skipped.'
          : 'Backup restored.',
      );
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
    applyDirectionToRecovery(directionSelect.value as SyncDirection);
  }
}

/**
 * Greys out the recovery action the sync direction forbids. The worker rejects it either
 * way; disabling the button says so before the user commits to a destructive action.
 */
function applyDirectionToRecovery(direction: SyncDirection): void {
  forcePullButton.disabled = direction === 'push-only';
  forcePullButton.title = forcePullButton.disabled
    ? 'Unavailable: this device is set to send changes only.'
    : '';
  forcePushButton.disabled = direction === 'pull-only';
  forcePushButton.title = forcePushButton.disabled
    ? 'Unavailable: this device is set to receive changes only.'
    : '';
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
