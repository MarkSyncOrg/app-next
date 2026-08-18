import { browser } from 'wxt/browser';
import {
  buildBackup,
  Mutex,
  type Settings,
  SyncConflictError,
  SyncEngine,
  SyncNotEnabledError,
  type SyncOutcome,
  type SyncStatus,
  SyncStore,
  XbrowsersyncApi,
} from '@marksyncorg/core';
import {
  isSyncRequest,
  type SyncRequest,
  type SyncResponse,
  type SyncResultData,
} from '../messaging';
import { commitLabel, currentBuild } from '../build-info';
import { createBackgroundLog } from '../logging/background-logger';
import { type LogContext, type LogEntry, sanitiseLogEntry } from '../logging/log-entry';
import { browserStorageArea } from '../webext/browser-storage-area';
import { WebextBookmarkProvider } from './webext-bookmark-provider';

const SYNC_ALARM = 'xbs-periodic-sync';
const LOG_ROTATE_ALARM = 'xbs-log-rotate';
/** How often expired log days are swept (writes rotate too; this covers idle periods). */
const LOG_ROTATE_INTERVAL_MINUTES = 60;
const PUSH_DEBOUNCE_MS = 2000;
/**
 * Storage key for the last sync-size measurement. Kept outside SyncStore's own keys
 * because it is a cache, not sync state — it is cleared explicitly on disable.
 */
const SYNC_USAGE_CACHE_KEY = 'syncUsageCache';
/** Only report lock waits above this, so uncontended operations stay quiet. */
const LOCK_WAIT_LOG_THRESHOLD_MS = 50;

const SYNC_OUTCOME_MESSAGES: Record<SyncOutcome, string> = {
  idle: 'Already up to date',
  pushed: 'Pushed local changes',
  pulled: 'Pulled remote changes',
  merged: 'Merged local and remote changes',
};

/** A sync-size measurement, tagged with the payload revision it was taken from. */
interface SyncUsageCache {
  lastUpdated: string;
  usedBytes: number;
}

/** What woke a background sync, so the log says why it ran. */
type SyncTrigger = 'alarm' | 'startup';

/** Which bookmark event scheduled a push. */
type BookmarkEvent = 'created' | 'changed' | 'moved' | 'removed';

/**
 * Loggable form of a sync ID.
 *
 * The service authenticates nothing beyond the ID: whoever holds it can read, overwrite
 * or destroy the sync, and it doubles as the key-derivation salt. Since the debug log is
 * downloadable and routinely attached to bug reports, only a short prefix is recorded —
 * enough to tell two syncs apart in a trace, useless to anyone who reads the file.
 */
function syncIdPrefix(syncId: string | undefined): string {
  return syncId ? `${syncId.slice(0, 6)}…` : 'none';
}

/**
 * Loggable view of a request. The password is never logged, the sync ID only as a
 * prefix, and payloads are reduced to counts: the debug log is downloadable and
 * routinely attached to bug reports, so it must not carry credentials or bookmark
 * contents.
 */
function describeRequest(request: SyncRequest): LogContext {
  switch (request.type) {
    case 'getServiceInfo':
      return { serviceUrl: request.serviceUrl };
    case 'enableNewSync':
      return { serviceUrl: request.serviceUrl, passwordProvided: request.password.length > 0 };
    case 'enableExistingSync':
      return {
        serviceUrl: request.serviceUrl,
        syncId: syncIdPrefix(request.syncId),
        passwordProvided: request.password.length > 0,
      };
    case 'setSettings':
      return { settings: request.settings };
    case 'restoreBackup':
      return { containers: request.bookmarks.length };
    default:
      return {};
  }
}

/**
 * Short error tag for a follow-up line (retry policy, recovery step) whose full
 * details — including the stack — were already logged where the error was caught.
 */
function errorTag(error: unknown): LogContext {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: 'NonError', errorMessage: String(error) };
}

/** Loggable summary of a successful response (again: counts and flags, no contents). */
function summariseResult(request: SyncRequest, data: unknown): LogContext {
  switch (request.type) {
    case 'getStatus': {
      const status = data as SyncStatus;
      return { enabled: status.enabled, lastUpdated: status.lastUpdated };
    }
    case 'getSettings':
    case 'setSettings':
      return { settings: data as Settings };
    case 'sync':
      return { outcome: (data as { outcome: SyncOutcome }).outcome };
    case 'getLog':
      return { entries: (data as LogEntry[]).length };
    case 'getSyncUsage':
      return { usedBytes: (data as { usedBytes: number }).usedBytes };
    default:
      return {};
  }
}

/**
 * Wires the sync engine into the MV3 service worker: handles popup messages, runs a
 * periodic sync, and pushes local bookmark edits (debounced). All durable state lives
 * in chrome.storage, so the controller is safe to recreate whenever the worker wakes.
 *
 * Every operation is traced to the daily-rotating debug log (start, duration, outcome
 * or error), including the background paths that surface no UI: a sync that only ever
 * fails on an alarm is otherwise invisible.
 */
export function initSyncController(): void {
  const { logger, store: logStore } = createBackgroundLog();
  const log = logger.child('sync');
  const storage = browserStorageArea();
  const store = new SyncStore(storage);
  const provider = new WebextBookmarkProvider({
    isToolbarEnabled: async () => (await store.getSettings()).syncBookmarksToolbar,
    logger: logger.child('bookmarks'),
  });
  const engine = new SyncEngine({
    store,
    provider,
    appVersion: browser.runtime.getManifest().version,
  });

  // Serialises every operation that reads or writes bookmarks/sync state so each
  // push/pull/restore runs atomically. Without it, a concurrent sync or a bookmark
  // edit can interleave with the destructive setBookmarks and corrupt the remote sync.
  const lock = new Mutex();

  // Non-zero while we are applying remote bookmarks, so the bookmark-change listeners
  // do not echo those writes straight back to the server. A counter (not a boolean)
  // keeps nested/overlapping applies correct.
  let applyingRemote = 0;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;

  async function applyRemote<T>(action: () => Promise<T>): Promise<T> {
    applyingRemote += 1;
    try {
      return await action();
    } finally {
      applyingRemote -= 1;
    }
  }

  /**
   * Runs an action under the bookmark lock, reporting contention: a long wait here is
   * the usual explanation for an operation that "hung".
   */
  async function withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const queuedAt = Date.now();
    return lock.runExclusive(async () => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs > LOCK_WAIT_LOG_THRESHOLD_MS) {
        await log.debug(`${name} waited for the bookmark lock`, { waitedMs });
      }
      return action();
    });
  }

  async function dispatch(request: SyncRequest): Promise<SyncResultData[SyncRequest['type']]> {
    switch (request.type) {
      case 'getStatus':
        return engine.getStatus();
      case 'getServiceInfo':
        return new XbrowsersyncApi(request.serviceUrl).getInfo();
      case 'getSyncUsage': {
        const info = await store.getSyncInfo();
        if (!info || !(await store.isSyncEnabled())) {
          throw new SyncNotEnabledError();
        }
        const api = new XbrowsersyncApi(info.serviceUrl);
        // The only way to size a sync is to download it, and the payload runs to
        // megabytes — far too much to re-fetch every time the popup opens. `lastUpdated`
        // changes whenever the stored payload does, so the cheap poll endpoint it exists
        // for tells us whether the measurement we already have is still current.
        const lastUpdated = await api.getLastUpdated(info.syncId);
        const cached = await storage.get<SyncUsageCache>(SYNC_USAGE_CACHE_KEY);
        if (cached?.lastUpdated === lastUpdated) {
          return { usedBytes: cached.usedBytes };
        }
        const { bookmarks } = await api.getSync(info.syncId);
        const usedBytes = new TextEncoder().encode(bookmarks).length;
        await storage.set<SyncUsageCache>(SYNC_USAGE_CACHE_KEY, { lastUpdated, usedBytes });
        return { usedBytes };
      }
      case 'enableNewSync': {
        const syncId = await withLock('enableNewSync', () =>
          engine.enableNewSync(request.serviceUrl, request.password),
        );
        await log.info('Created new sync', {
          syncId: syncIdPrefix(syncId),
          serviceUrl: request.serviceUrl,
        });
        return { syncId };
      }
      case 'enableExistingSync':
        await withLock('enableExistingSync', () =>
          applyRemote(() =>
            engine.enableExistingSync(request.serviceUrl, request.syncId, request.password),
          ),
        );
        await log.info('Enabled existing sync', {
          syncId: syncIdPrefix(request.syncId),
          serviceUrl: request.serviceUrl,
        });
        return null;
      case 'sync':
        return withLock('sync', async () => {
          // Reconciles automatically: push, pull, or three-way merge as needed.
          const outcome = await applyRemote(() => engine.sync());
          await log.info(SYNC_OUTCOME_MESSAGES[outcome], { outcome, trigger: 'manual' });
          return { outcome };
        });
      case 'forcePull':
        await log.info('Forcing full pull from server…');
        await withLock('forcePull', () => applyRemote(() => engine.forcePull()));
        await log.info('Forced full pull complete');
        return null;
      case 'forcePush':
        await log.info('Forcing full push to server…');
        await withLock('forcePush', () => engine.forcePush());
        await log.info('Forced full push complete');
        return null;
      case 'disable':
        await withLock('disable', () => engine.disable());
        // engine.disable() clears SyncStore's own keys; the usage cache is ours.
        await storage.remove(SYNC_USAGE_CACHE_KEY);
        await log.info('Sync disabled');
        return null;
      case 'getSettings':
        return store.getSettings();
      case 'setSettings': {
        const settings = await store.setSettings(request.settings);
        await log.info('Settings updated', { changed: request.settings, settings });
        await applyAlarm();
        return settings;
      }
      case 'getLog':
        return logStore.getEntries();
      case 'clearLog':
        await logStore.clear();
        await log.info('Debug log cleared');
        return null;
      case 'createBackup':
        return withLock('createBackup', async () => {
          const bookmarks = await provider.getBookmarks();
          const info = await store.getSyncInfo();
          const sync =
            info && (await store.isSyncEnabled())
              ? {
                  id: info.syncId,
                  url: info.serviceUrl,
                  type: 'xbrowsersync',
                  version: await store.getSyncVersion(),
                }
              : undefined;
          await log.info('Backup created', {
            containers: bookmarks.length,
            includesSyncInfo: sync !== undefined,
          });
          return buildBackup(bookmarks, sync);
        });
      case 'restoreBackup':
        await log.info('Restoring backup…', { containers: request.bookmarks.length });
        await withLock('restoreBackup', () => applyRemote(() => engine.restore(request.bookmarks)));
        await log.info('Backup restored', { containers: request.bookmarks.length });
        return null;
      case 'log':
        // Handled before dispatch; listed for exhaustiveness.
        return null;
    }
  }

  /** Appends a log entry relayed by the popup/options page. */
  async function appendRelayedEntry(entry: LogEntry): Promise<void> {
    const sanitised = sanitiseLogEntry(entry);
    if (!sanitised) {
      await log.warn('Discarded a malformed relayed log entry');
      return;
    }
    await logStore.append(sanitised);
  }

  async function handle(request: SyncRequest): Promise<SyncResponse<unknown>> {
    if (request.type === 'log') {
      // Not traced as a request: it *is* a log write, and tracing it would double
      // every UI line in the log.
      await appendRelayedEntry(request.entry);
      return { ok: true, data: null };
    }
    try {
      const data = await log.operation(`Request ${request.type}`, () => dispatch(request), {
        context: describeRequest(request),
        summarise: (result) => summariseResult(request, result),
      });
      return { ok: true, data };
    } catch (error) {
      // `operation` already logged the failure with its name, message and stack.
      const err = error as Error;
      return { ok: false, error: { name: err.name, message: err.message } };
    }
  }

  /**
   * Background sync (alarm/startup): push if there are local edits, otherwise pull.
   * Best-effort and never overwrites un-pushed local changes. Failures are logged
   * rather than swallowed — a silently failing alarm is the hardest bug to chase.
   */
  async function safeSync(trigger: SyncTrigger): Promise<void> {
    try {
      await withLock('backgroundSync', async () => {
        if (!(await store.isSyncEnabled())) {
          await log.debug('Background sync skipped: sync is not enabled', { trigger });
          return;
        }
        await log.operation('Background sync', () => applyRemote(() => engine.sync()), {
          context: { trigger },
          successLevel: 'info',
          summarise: (outcome) => ({ outcome, detail: SYNC_OUTCOME_MESSAGES[outcome] }),
        });
      });
    } catch (error) {
      // Already logged by `operation`; the popup surfaces explicit failures and the
      // next alarm retries.
      await log.warn('Background sync will be retried on the next alarm', {
        trigger,
        ...errorTag(error),
      });
    }
  }

  /** Push local edits; on a conflict, pull so the device converges on remote state. */
  async function pushLocalChanges(event: BookmarkEvent): Promise<void> {
    try {
      await withLock('pushLocalChanges', async () => {
        if (!(await store.isSyncEnabled())) {
          await log.debug('Push skipped: sync is not enabled', { event });
          return;
        }
        await log.operation('Push local bookmark changes', () => engine.push(), {
          context: { event },
          successLevel: 'info',
        });
      });
    } catch (error) {
      if (error instanceof SyncConflictError) {
        await log.warn('Push conflicted with a newer server copy; pulling to converge', { event });
        try {
          await withLock('convergencePull', () =>
            applyRemote(() =>
              log.operation('Convergence pull', () => engine.pull(), { successLevel: 'info' }),
            ),
          );
        } catch (pullError) {
          await log.warn('Convergence pull failed; the periodic sync will retry', {
            event,
            ...errorTag(pullError),
          });
        }
        return;
      }
      // Other errors are transient; the periodic alarm will retry.
      await log.warn('Push failed; the periodic sync will retry', { event, ...errorTag(error) });
    }
  }

  /** Creates/clears the periodic-sync alarm from the configured interval. */
  async function applyAlarm(): Promise<void> {
    const { syncIntervalMinutes } = await store.getSettings();
    await browser.alarms.clear(SYNC_ALARM);
    if (syncIntervalMinutes > 0) {
      browser.alarms.create(SYNC_ALARM, { periodInMinutes: syncIntervalMinutes });
      await log.debug('Periodic sync scheduled', { intervalMinutes: syncIntervalMinutes });
    } else {
      await log.debug('Periodic sync disabled (auto-sync off)');
    }
  }

  /** Drops log days outside the retention window (writes rotate too). */
  async function rotateLog(): Promise<void> {
    try {
      const removedDays = await logStore.rotate();
      if (removedDays.length > 0) {
        await log.info('Rotated the debug log', {
          removedDays,
          keptDays: await logStore.getDays(),
        });
      }
    } catch (error) {
      await log.failure('Debug log rotation failed', error);
    }
  }

  function schedulePush(event: BookmarkEvent, id?: string): void {
    if (applyingRemote > 0) {
      void log.debug('Bookmark change ignored: applying remote changes', { event, id });
      return;
    }
    void log.debug('Local bookmark change detected', {
      event,
      id,
      debounceMs: PUSH_DEBOUNCE_MS,
      rescheduled: pushTimer !== undefined,
    });
    if (pushTimer) {
      clearTimeout(pushTimer);
    }
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      void (async () => {
        try {
          if (!(await store.getSettings()).syncOnChange) {
            await log.debug('Debounced push skipped: sync-on-change is off', { event });
            return;
          }
          await pushLocalChanges(event);
        } catch (error) {
          await log.failure('Debounced push could not start', error, { event });
        }
      })();
    }, PUSH_DEBOUNCE_MS);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (isSyncRequest(message)) {
      return handle(message);
    }
    void log.debug('Ignoring an unrecognised runtime message', {
      messageType:
        typeof message === 'object' && message !== null && 'type' in message
          ? String((message as { type: unknown }).type)
          : typeof message,
    });
    return undefined;
  });

  // The MV3 worker is restarted for nearly every event, so this line doubles as the
  // wake-up marker that separates one burst of activity from the next.
  void log.debug('Service worker started', {
    appVersion: browser.runtime.getManifest().version,
    commit: commitLabel(currentBuild(browser.runtime.getManifest().version)),
    browser: import.meta.env.BROWSER,
    mode: import.meta.env.MODE,
  });

  void applyAlarm();
  browser.alarms.create(LOG_ROTATE_ALARM, { periodInMinutes: LOG_ROTATE_INTERVAL_MINUTES });
  void rotateLog();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void safeSync('alarm');
    } else if (alarm.name === LOG_ROTATE_ALARM) {
      void rotateLog();
    } else {
      void log.debug('Ignoring an unknown alarm', { alarm: alarm.name });
    }
  });

  browser.bookmarks.onCreated.addListener((id) => schedulePush('created', id));
  browser.bookmarks.onChanged.addListener((id) => schedulePush('changed', id));
  browser.bookmarks.onMoved.addListener((id) => schedulePush('moved', id));
  browser.bookmarks.onRemoved.addListener((id) => schedulePush('removed', id));

  browser.runtime.onStartup.addListener(() => {
    void log.info('Browser startup');
    void rotateLog();
    void safeSync('startup');
  });
}
