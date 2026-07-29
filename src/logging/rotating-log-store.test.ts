import { describe, expect, it } from 'vitest';
import type { LogEntry } from './log-entry';
import { type LogStorageArea, RotatingLogStore } from './rotating-log-store';

class MemoryArea implements LogStorageArea {
  readonly values = new Map<string, unknown>();
  readonly reads: string[] = [];

  get<T>(key: string): Promise<T | undefined> {
    this.reads.push(key);
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): string[] {
    return [...this.values.keys()].sort();
  }
}

/** Local-time timestamp, so day bucketing matches the store's local-day keys. */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function entry(timestamp: number, message: string): LogEntry {
  return { timestamp, level: 'info', message };
}

describe('RotatingLogStore', () => {
  it('buckets entries by local day and returns them oldest first', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { now: () => at(2026, 7, 28) });

    await store.append(entry(at(2026, 7, 27, 9), 'yesterday'));
    await store.append(entry(at(2026, 7, 28, 8), 'today early'));
    await store.append(entry(at(2026, 7, 28, 20), 'today late'));

    expect(await store.getDays()).toEqual(['2026-07-27', '2026-07-28']);
    expect((await store.getEntries()).map((e) => e.message)).toEqual([
      'yesterday',
      'today early',
      'today late',
    ]);
    expect(area.keys()).toEqual(['log:day:2026-07-27', 'log:day:2026-07-28', 'log:index']);
  });

  it('drops days outside the retention window when appending', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { retentionDays: 3, now: () => at(2026, 7, 28) });

    for (const day of [24, 25, 26, 27, 28]) {
      await store.append(entry(at(2026, 7, day), `day ${day}`));
    }

    expect(await store.getDays()).toEqual(['2026-07-26', '2026-07-27', '2026-07-28']);
    expect((await store.getEntries()).map((e) => e.message)).toEqual([
      'day 26',
      'day 27',
      'day 28',
    ]);
    expect(area.values.has('log:day:2026-07-24')).toBe(false);
  });

  it('rotates expired days without a new entry, reporting what it removed', async () => {
    const area = new MemoryArea();
    let today = at(2026, 7, 28);
    const store = new RotatingLogStore(area, { retentionDays: 2, now: () => today });

    await store.append(entry(at(2026, 7, 27), 'old'));
    await store.append(entry(at(2026, 7, 28), 'recent'));

    today = at(2026, 7, 30);
    expect(await store.rotate()).toEqual(['2026-07-27', '2026-07-28']);
    expect(await store.getEntries()).toEqual([]);
    expect(area.values.has('log:day:2026-07-28')).toBe(false);
  });

  it('caps entries within a day, dropping the oldest', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { maxEntriesPerDay: 3, now: () => at(2026, 7, 28) });

    for (let i = 0; i < 5; i += 1) {
      await store.append(entry(at(2026, 7, 28), `entry ${i}`));
    }

    expect((await store.getEntries()).map((e) => e.message)).toEqual([
      'entry 2',
      'entry 3',
      'entry 4',
    ]);
  });

  it('reuses the cached bucket across consecutive appends', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { now: () => at(2026, 7, 28) });

    await store.append(entry(at(2026, 7, 28), 'first'));
    area.reads.length = 0;
    await store.append(entry(at(2026, 7, 28), 'second'));

    expect(area.reads).not.toContain('log:day:2026-07-28');
    expect((await store.getEntries()).map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('serialises concurrent appends instead of losing them', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { now: () => at(2026, 7, 28) });

    await Promise.all(
      Array.from({ length: 20 }, (_value, i) => store.append(entry(at(2026, 7, 28), `n${i}`))),
    );

    expect(await store.getEntries()).toHaveLength(20);
  });

  it('imports the pre-rotation log into daily buckets, once', async () => {
    const area = new MemoryArea();
    await area.set('traceLog', [
      entry(at(2026, 7, 27), 'legacy yesterday'),
      entry(at(2026, 7, 28), 'legacy today'),
    ]);
    const store = new RotatingLogStore(area, { now: () => at(2026, 7, 28) });

    await store.append(entry(at(2026, 7, 28, 13), 'new'));

    expect((await store.getEntries()).map((e) => e.message)).toEqual([
      'legacy yesterday',
      'legacy today',
      'new',
    ]);
    expect(area.values.has('traceLog')).toBe(false);
  });

  it('clears every bucket and the index', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { now: () => at(2026, 7, 28) });
    await store.append(entry(at(2026, 7, 27), 'a'));
    await store.append(entry(at(2026, 7, 28), 'b'));

    await store.clear();

    expect(await store.getEntries()).toEqual([]);
    expect(area.keys()).toEqual([]);
  });

  it('keeps the queue alive after a storage failure', async () => {
    const area = new MemoryArea();
    const store = new RotatingLogStore(area, { now: () => at(2026, 7, 28) });
    const original = area.set.bind(area);
    let failNext = true;
    area.set = <T>(key: string, value: T): Promise<void> => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('storage full'));
      }
      return original(key, value);
    };

    await expect(store.append(entry(at(2026, 7, 28), 'lost'))).rejects.toThrow('storage full');
    await store.append(entry(at(2026, 7, 28), 'kept'));

    expect((await store.getEntries()).map((e) => e.message)).toEqual(['kept']);
  });
});
