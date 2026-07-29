import { describe, expect, it } from 'vitest';
import {
  dayKeyOf,
  describeError,
  formatLog,
  formatLogEntry,
  type LogEntry,
  sanitiseLogEntry,
  stringifyContext,
} from './log-entry';

function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime();
}

describe('formatLogEntry', () => {
  it('renders timestamp, level, scope, message and context', () => {
    const entry: LogEntry = {
      timestamp: 0,
      level: 'warn',
      scope: 'sync',
      message: 'hi',
      context: { outcome: 'pushed' },
    };

    expect(formatLogEntry(entry)).toBe(
      '1970-01-01T00:00:00.000Z\tWARN\t[sync] hi {"outcome":"pushed"}',
    );
  });

  it('omits the scope and context when absent', () => {
    expect(formatLogEntry({ timestamp: 0, level: 'info', message: 'hi' })).toBe(
      '1970-01-01T00:00:00.000Z\tINFO\thi',
    );
  });
});

describe('formatLog', () => {
  it('groups entries under a header per calendar day', () => {
    const text = formatLog([
      { timestamp: at(2026, 7, 27), level: 'info', message: 'a' },
      { timestamp: at(2026, 7, 28), level: 'info', message: 'b' },
    ]);

    const lines = text.split('\n');
    expect(lines[0]).toBe('===== 2026-07-27 =====');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('===== 2026-07-28 =====');
  });
});

describe('stringifyContext', () => {
  it('survives circular references and unserialisable values', () => {
    const context: Record<string, unknown> = { id: 1n, fn: () => undefined };
    context.self = context;

    expect(stringifyContext(context)).toBe('{"id":"1n","fn":"[Function]","self":"[Circular]"}');
  });

  it('truncates long strings', () => {
    expect(stringifyContext({ blob: 'x'.repeat(600) })).toContain('600 chars');
  });
});

describe('describeError', () => {
  it('extracts name, message and stack', () => {
    const error = new Error('nope');
    error.name = 'SyncConflictError';

    expect(describeError(error)).toMatchObject({
      errorName: 'SyncConflictError',
      errorMessage: 'nope',
    });
  });

  it('handles thrown non-errors', () => {
    expect(describeError('plain')).toEqual({ errorName: 'NonError', errorMessage: 'plain' });
  });
});

describe('dayKeyOf', () => {
  it('uses the local calendar day, zero padded', () => {
    expect(dayKeyOf(at(2026, 1, 5, 23))).toBe('2026-01-05');
  });
});

describe('sanitiseLogEntry', () => {
  it('accepts a well-formed entry', () => {
    const entry = { timestamp: 5, level: 'info', scope: 'popup', message: 'hi', context: { a: 1 } };

    expect(sanitiseLogEntry(entry)).toEqual(entry);
  });

  it('defaults a missing timestamp to now', () => {
    expect(sanitiseLogEntry({ level: 'info', message: 'hi' }, 42)?.timestamp).toBe(42);
  });

  it('rejects anything that is not a log entry', () => {
    expect(sanitiseLogEntry(undefined)).toBeUndefined();
    expect(sanitiseLogEntry({ level: 'nope', message: 'hi' })).toBeUndefined();
    expect(sanitiseLogEntry({ level: 'info', message: 42 })).toBeUndefined();
  });

  it('truncates an over-long message', () => {
    const entry = sanitiseLogEntry({ level: 'info', message: 'x'.repeat(2000) });

    expect(entry?.message.length).toBeLessThan(1100);
  });
});
