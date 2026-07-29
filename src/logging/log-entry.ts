/**
 * Log record shape and text formatting.
 *
 * Deliberately dependency-free (no `@marksyncorg/core`, no `wxt/browser`) so the same
 * types can be used by the service worker, the popup and the options page, and unit
 * tested in a plain Node environment.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Severity ranking, used to filter entries below the configured minimum level. */
export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Structured details attached to an entry. Values must be JSON-serialisable. */
export type LogContext = Record<string, unknown>;

export interface LogEntry {
  /** Epoch milliseconds; also decides which daily bucket the entry rotates into. */
  timestamp: number;
  level: LogLevel;
  /** Component that emitted the entry (`sync`, `bookmarks`, `popup`, `options`, …). */
  scope?: string;
  message: string;
  /** Structured details, e.g. `{ durationMs: 12, outcome: 'pushed' }`. */
  context?: LogContext;
}

/** Longest string kept in a serialised context value; longer ones are truncated. */
const MAX_VALUE_LENGTH = 500;

/** Truncates over-long messages so a single entry cannot blow up the stored log. */
export const MAX_MESSAGE_LENGTH = 1000;

export function truncate(text: string, maxLength = MAX_VALUE_LENGTH): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}… (${text.length} chars)` : text;
}

/**
 * JSON-stringifies a context object without ever throwing: cycles, `BigInt`, `Error`
 * and non-serialisable values are all reduced to something printable. Logging must
 * never be able to break the operation it is describing.
 */
export function stringifyContext(context: LogContext): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(context, (_key, value: unknown) => {
      if (typeof value === 'bigint') {
        return `${value.toString()}n`;
      }
      if (typeof value === 'function') {
        return '[Function]';
      }
      if (typeof value === 'string') {
        return truncate(value);
      }
      if (value instanceof Error) {
        return describeError(value);
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    return '[unserialisable context]';
  }
}

/** Reduces an unknown thrown value to a loggable `{ name, message, stack }`. */
export function describeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { stack: truncate(error.stack, 2000) } : {}),
    };
  }
  return { errorName: 'NonError', errorMessage: truncate(String(error)) };
}

/**
 * Normalises an entry that crossed a runtime boundary (popup/options → worker) into a
 * well-formed, size-bounded {@link LogEntry}. Returns `undefined` for anything that is
 * not a log entry at all.
 */
export function sanitiseLogEntry(value: unknown, now = Date.now()): LogEntry | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Partial<LogEntry>;
  if (typeof candidate.message !== 'string' || !isLogLevel(candidate.level)) {
    return undefined;
  }
  const timestamp =
    typeof candidate.timestamp === 'number' && Number.isFinite(candidate.timestamp)
      ? candidate.timestamp
      : now;
  const context =
    typeof candidate.context === 'object' && candidate.context !== null
      ? (candidate.context as LogContext)
      : undefined;
  return {
    timestamp,
    level: candidate.level,
    ...(typeof candidate.scope === 'string' ? { scope: truncate(candidate.scope, 60) } : {}),
    message: truncate(candidate.message, MAX_MESSAGE_LENGTH),
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };
}

/** Local calendar day (`YYYY-MM-DD`) an entry belongs to — the rotation bucket key. */
export function dayKeyOf(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** One entry as a tab-separated line: ISO timestamp, level, scope, message, context. */
export function formatLogEntry(entry: LogEntry): string {
  const scope = entry.scope ? `[${entry.scope}] ` : '';
  const context =
    entry.context && Object.keys(entry.context).length > 0
      ? ` ${stringifyContext(entry.context)}`
      : '';
  return `${new Date(entry.timestamp).toISOString()}\t${entry.level.toUpperCase()}\t${scope}${entry.message}${context}`;
}

/**
 * Formats entries for display/download, with a header line whenever the calendar day
 * changes so the daily rotation boundaries are visible in the downloaded file.
 */
export function formatLog(entries: LogEntry[]): string {
  const lines: string[] = [];
  let currentDay = '';
  for (const entry of entries) {
    const day = dayKeyOf(entry.timestamp);
    if (day !== currentDay) {
      if (currentDay) {
        lines.push('');
      }
      lines.push(`===== ${day} =====`);
      currentDay = day;
    }
    lines.push(formatLogEntry(entry));
  }
  return lines.join('\n');
}
