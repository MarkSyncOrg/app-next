import { describe, expect, it, vi } from 'vitest';
import { Logger, MemorySink } from './logger';

describe('Logger', () => {
  it('stamps entries with level, scope and timestamp', async () => {
    const sink = new MemorySink();
    const logger = new Logger({ scope: 'sync', sinks: [sink], now: () => 1000 });

    await logger.info('started', { trigger: 'alarm' });
    await logger.error('boom');

    expect(sink.entries).toEqual([
      {
        timestamp: 1000,
        level: 'info',
        scope: 'sync',
        message: 'started',
        context: { trigger: 'alarm' },
      },
      { timestamp: 1000, level: 'error', scope: 'sync', message: 'boom' },
    ]);
  });

  it('nests child scopes and shares the sinks', async () => {
    const sink = new MemorySink();
    const logger = new Logger({ scope: 'sync', sinks: [sink] });

    await logger.child('bookmarks').debug('read');

    expect(sink.entries[0]?.scope).toBe('sync:bookmarks');
  });

  it('drops entries below the minimum level', async () => {
    const sink = new MemorySink();
    const logger = new Logger({ minLevel: 'warn', sinks: [sink] });

    await logger.debug('noise');
    await logger.info('noise');
    await logger.warn('kept');

    expect(sink.entries.map((entry) => entry.message)).toEqual(['kept']);
  });

  it('never lets a failing sink break the caller', async () => {
    const failing = {
      write: () => {
        throw new Error('sink down');
      },
    };
    const sink = new MemorySink();
    const logger = new Logger({ sinks: [failing, sink] });

    await expect(logger.info('still logged')).resolves.toBeUndefined();
    expect(sink.entries).toHaveLength(1);
  });

  it('traces an operation with its duration and summary', async () => {
    const sink = new MemorySink();
    let clock = 0;
    const logger = new Logger({ sinks: [sink], now: () => clock });

    const result = await logger.operation(
      'Sync',
      () => {
        clock = 42;
        return Promise.resolve('pushed');
      },
      {
        context: { trigger: 'alarm' },
        successLevel: 'info',
        summarise: (outcome) => ({ outcome }),
      },
    );

    expect(result).toBe('pushed');
    expect(sink.entries.map((entry) => [entry.level, entry.message])).toEqual([
      ['debug', 'Sync started'],
      ['info', 'Sync succeeded'],
    ]);
    expect(sink.entries[1]?.context).toMatchObject({ trigger: 'alarm', outcome: 'pushed' });
    expect(sink.entries[1]?.context?.durationMs).toBe(42);
  });

  it('logs and rethrows a failed operation with the error details', async () => {
    const sink = new MemorySink();
    const logger = new Logger({ sinks: [sink] });
    const boom = new Error('offline');
    boom.name = 'NetworkError';

    await expect(logger.operation('Sync', () => Promise.reject(boom))).rejects.toThrow('offline');

    expect(sink.entries[1]?.level).toBe('error');
    expect(sink.entries[1]?.message).toBe('Sync failed');
    expect(sink.entries[1]?.context).toMatchObject({
      errorName: 'NetworkError',
      errorMessage: 'offline',
    });
  });

  it('routes console output by level', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { consoleSink } = await import('./logger');
    const logger = new Logger({ sinks: [consoleSink('MarkSync')], now: () => 0 });

    await logger.debug('quiet');
    await logger.warn('loud');

    expect(debug).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARN\tloud'));
    debug.mockRestore();
    warn.mockRestore();
  });
});
