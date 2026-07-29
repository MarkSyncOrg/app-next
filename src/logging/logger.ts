import {
  describeError,
  formatLogEntry,
  type LogContext,
  type LogEntry,
  type LogLevel,
  LOG_LEVEL_SEVERITY,
  MAX_MESSAGE_LENGTH,
  truncate,
} from './log-entry';

/** Destination for finished entries (storage, console, the background worker, …). */
export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
}

export interface LoggerOptions {
  /** Component name prefixed to every entry. */
  scope?: string;
  /** Entries below this level are dropped (default `debug`). */
  minLevel?: LogLevel;
  sinks?: LogSink[];
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * Application logger: levelled, scoped, structured.
 *
 * Every operation worth debugging goes through {@link Logger.operation}, which records
 * a `started` line, then either a `succeeded` line with the duration and a result
 * summary or a `failed` line with the error — so a downloaded log shows what ran, in
 * what order, how long it took and where it broke.
 *
 * Logging is best-effort by contract: a failing sink is swallowed, never propagated to
 * the caller, so a storage hiccup can never break sync itself.
 */
export class Logger {
  private readonly scope?: string;
  private readonly minSeverity: number;
  private readonly sinks: LogSink[];
  private readonly now: () => number;

  constructor(options: LoggerOptions = {}) {
    this.scope = options.scope;
    this.minSeverity = LOG_LEVEL_SEVERITY[options.minLevel ?? 'debug'];
    this.sinks = options.sinks ?? [];
    this.now = options.now ?? (() => Date.now());
  }

  /** A logger writing to the same sinks under a nested scope (`sync:bookmarks`). */
  child(scope: string): Logger {
    return new Logger({
      scope: this.scope ? `${this.scope}:${scope}` : scope,
      minLevel: severityToLevel(this.minSeverity),
      sinks: this.sinks,
      now: this.now,
    });
  }

  debug(message: string, context?: LogContext): Promise<void> {
    return this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): Promise<void> {
    return this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): Promise<void> {
    return this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): Promise<void> {
    return this.log('error', message, context);
  }

  /** Logs a caught error with its name, message and stack. */
  failure(message: string, error: unknown, context?: LogContext): Promise<void> {
    return this.log('error', message, { ...context, ...describeError(error) });
  }

  async log(level: LogLevel, message: string, context?: LogContext): Promise<void> {
    if (LOG_LEVEL_SEVERITY[level] < this.minSeverity) {
      return;
    }
    const entry: LogEntry = {
      timestamp: this.now(),
      level,
      ...(this.scope ? { scope: this.scope } : {}),
      message: truncate(message, MAX_MESSAGE_LENGTH),
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };
    await this.write(entry);
  }

  /** Writes an already-built entry (used to relay entries from another context). */
  async write(entry: LogEntry): Promise<void> {
    if (LOG_LEVEL_SEVERITY[entry.level] < this.minSeverity) {
      return;
    }
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.write(entry);
        } catch {
          // A broken sink must never break the operation being logged.
        }
      }),
    );
  }

  /**
   * Runs and traces an operation: start, duration, and outcome or error. The error is
   * logged and rethrown, so callers keep their normal control flow.
   *
   * @param options.summarise builds the context logged on success (e.g. counts, outcome).
   * @param options.successLevel level of the success line (default `debug`); raise it
   * to `info` for operations a user should see in the downloaded log.
   */
  async operation<T>(
    name: string,
    run: () => Promise<T>,
    options: {
      context?: LogContext;
      summarise?: (result: T) => LogContext;
      successLevel?: LogLevel;
    } = {},
  ): Promise<T> {
    const startedAt = this.now();
    await this.debug(`${name} started`, options.context);
    try {
      const result = await run();
      await this.log(options.successLevel ?? 'debug', `${name} succeeded`, {
        ...options.context,
        durationMs: this.now() - startedAt,
        ...(options.summarise ? options.summarise(result) : {}),
      });
      return result;
    } catch (error) {
      await this.failure(`${name} failed`, error, {
        ...options.context,
        durationMs: this.now() - startedAt,
      });
      throw error;
    }
  }
}

function severityToLevel(severity: number): LogLevel {
  const found = (Object.keys(LOG_LEVEL_SEVERITY) as LogLevel[]).find(
    (level) => LOG_LEVEL_SEVERITY[level] === severity,
  );
  return found ?? 'debug';
}

/**
 * Mirrors entries to the console so they are visible live in the service-worker /
 * page devtools, where the stored log is not.
 */
export function consoleSink(prefix = 'MarkSync'): LogSink {
  return {
    write(entry) {
      const line = `${prefix} ${formatLogEntry(entry)}`;
      switch (entry.level) {
        case 'error':
          console.error(line);
          break;
        case 'warn':
          console.warn(line);
          break;
        case 'info':
          console.info(line);
          break;
        default:
          console.debug(line);
      }
    },
  };
}

/** Sink that keeps entries in memory; useful in tests. */
export class MemorySink implements LogSink {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}
