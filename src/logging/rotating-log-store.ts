import { dayKeyOf, type LogEntry } from './log-entry';

/**
 * Daily-rotating log storage.
 *
 * Entries are bucketed per local calendar day (`log:day:YYYY-MM-DD`) with an index of
 * the days currently held (`log:index`). Buckets older than the retention window are
 * deleted on every write, so the log rotates without an explicit "rotate at midnight"
 * job — plus {@link RotatingLogStore.rotate} for a scheduled/idle sweep.
 *
 * The MV3 service worker is ephemeral and re-entrant: several operations may log at
 * the same time, so every read-modify-write goes through an internal queue. Without it
 * concurrent appends would read the same bucket and overwrite each other.
 */

const INDEX_KEY = 'log:index';
const DAY_KEY_PREFIX = 'log:day:';
/** Key written by the previous (non-rotating, single-array) logger; imported once. */
const LEGACY_KEY = 'traceLog';

/** Calendar days of history kept, including today. */
export const DEFAULT_RETENTION_DAYS = 7;
/**
 * Per-day cap; the oldest entries of the day are dropped past this. A bucket is
 * rewritten whole on every append, so this also bounds the cost of a single log line
 * (~500 entries ≈ 60 kB) — deliberately modest, since a runaway loop is exactly when
 * the log must stay cheap.
 */
export const DEFAULT_MAX_ENTRIES_PER_DAY = 500;

export interface LogStorageArea {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface RotatingLogStoreOptions {
  /** Calendar days of history to keep (default 7). */
  retentionDays?: number;
  /** Maximum entries per day (default 500). */
  maxEntriesPerDay?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

function dayKey(day: string): string {
  return `${DAY_KEY_PREFIX}${day}`;
}

/** Subtracts whole days from a timestamp and returns the resulting day key. */
function shiftDayKey(timestamp: number, days: number): string {
  const date = new Date(timestamp);
  date.setDate(date.getDate() - days);
  return dayKeyOf(date.getTime());
}

export class RotatingLogStore {
  private readonly retentionDays: number;
  private readonly maxEntriesPerDay: number;
  private readonly now: () => number;
  /** Serialises read-modify-write sequences against the shared storage area. */
  private queue: Promise<unknown> = Promise.resolve();
  private legacyImported = false;
  /**
   * Write-through copy of the bucket last appended to, so a burst of log lines does
   * not re-read it every time. The service worker is the only writer, and only one
   * instance runs at a time; the cache is dropped whenever a write fails.
   */
  private cached?: { day: string; entries: LogEntry[] };

  constructor(
    private readonly area: LogStorageArea,
    options: RotatingLogStoreOptions = {},
  ) {
    this.retentionDays = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    this.maxEntriesPerDay = Math.max(1, options.maxEntriesPerDay ?? DEFAULT_MAX_ENTRIES_PER_DAY);
    this.now = options.now ?? (() => Date.now());
  }

  /** Appends an entry to today's bucket and prunes buckets outside the window. */
  append(entry: LogEntry): Promise<void> {
    return this.exclusive(async () => {
      await this.importLegacy();

      const day = dayKeyOf(entry.timestamp);
      const entries = this.cached?.day === day ? this.cached.entries : await this.readDay(day);
      entries.push(entry);
      if (entries.length > this.maxEntriesPerDay) {
        entries.splice(0, entries.length - this.maxEntriesPerDay);
      }
      this.cached = undefined;
      await this.area.set(dayKey(day), entries);
      this.cached = { day, entries };

      // The index only changes when a new day starts — which is also the only moment
      // an older day can fall out of the window, so pruning belongs right here.
      const index = await this.readIndex();
      if (!index.includes(day)) {
        await this.pruneIndex([...index, day]);
      }
    });
  }

  /** All retained entries, oldest first. */
  getEntries(): Promise<LogEntry[]> {
    return this.exclusive(async () => {
      await this.importLegacy();
      const entries: LogEntry[] = [];
      for (const day of await this.readIndex()) {
        entries.push(...(await this.readDay(day)));
      }
      return entries;
    });
  }

  /** Day buckets currently held, oldest first. */
  getDays(): Promise<string[]> {
    return this.exclusive(() => this.readIndex());
  }

  /**
   * Drops buckets outside the retention window. Appending rotates too; this exists so
   * a long-idle worker (or one woken by an alarm) still lets stale days expire.
   * Resolves with the days that were removed.
   */
  rotate(): Promise<string[]> {
    return this.exclusive(async () => {
      await this.importLegacy();
      return this.pruneIndex(await this.readIndex());
    });
  }

  /** Removes every bucket, the index and any legacy log. */
  clear(): Promise<void> {
    return this.exclusive(async () => {
      for (const day of await this.readIndex()) {
        await this.area.remove(dayKey(day));
      }
      await this.area.remove(INDEX_KEY);
      await this.area.remove(LEGACY_KEY);
      this.cached = undefined;
      this.legacyImported = true;
    });
  }

  /** Runs `action` after every previously queued action, whatever their outcome. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    // Keep the chain alive even when a caller rejects: the next action must still run.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readIndex(): Promise<string[]> {
    const index = await this.area.get<string[]>(INDEX_KEY);
    return Array.isArray(index) ? [...index].filter((day) => typeof day === 'string').sort() : [];
  }

  /** Reads a bucket as a private copy, so callers can mutate it before writing back. */
  private async readDay(day: string): Promise<LogEntry[]> {
    const entries = await this.area.get<LogEntry[]>(dayKey(day));
    return Array.isArray(entries) ? [...entries] : [];
  }

  /**
   * Deletes buckets older than the retention window (and any beyond the day count, in
   * case a clock change created future-dated buckets), then persists the index.
   */
  private async pruneIndex(index: string[]): Promise<string[]> {
    const sorted = [...new Set(index)].sort();
    const cutoff = shiftDayKey(this.now(), this.retentionDays - 1);
    let kept = sorted.filter((day) => day >= cutoff);
    if (kept.length > this.retentionDays) {
      kept = kept.slice(kept.length - this.retentionDays);
    }
    const removed = sorted.filter((day) => !kept.includes(day));
    for (const day of removed) {
      await this.area.remove(dayKey(day));
      if (this.cached?.day === day) {
        this.cached = undefined;
      }
    }
    await this.area.set(INDEX_KEY, kept);
    return removed;
  }

  /**
   * One-shot migration of the pre-rotation log (a single capped array) into daily
   * buckets, so upgrading users keep their recent history instead of losing it.
   */
  private async importLegacy(): Promise<void> {
    if (this.legacyImported) {
      return;
    }
    this.legacyImported = true;
    const legacy = await this.area.get<LogEntry[]>(LEGACY_KEY);
    if (!Array.isArray(legacy) || legacy.length === 0) {
      await this.area.remove(LEGACY_KEY);
      return;
    }

    const byDay = new Map<string, LogEntry[]>();
    for (const entry of legacy) {
      const timestamp = typeof entry?.timestamp === 'number' ? entry.timestamp : this.now();
      const day = dayKeyOf(timestamp);
      const bucket = byDay.get(day) ?? (await this.readDay(day));
      bucket.push({ ...entry, timestamp });
      byDay.set(day, bucket);
    }

    for (const [day, entries] of byDay) {
      if (entries.length > this.maxEntriesPerDay) {
        entries.splice(0, entries.length - this.maxEntriesPerDay);
      }
      entries.sort((a, b) => a.timestamp - b.timestamp);
      await this.area.set(dayKey(day), entries);
    }
    await this.area.remove(LEGACY_KEY);
    this.cached = undefined;
    await this.pruneIndex([...(await this.readIndex()), ...byDay.keys()]);
  }
}
