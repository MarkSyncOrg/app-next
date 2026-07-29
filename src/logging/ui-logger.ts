import { browser } from 'wxt/browser';
import type { SyncRequest } from '../messaging';
import { consoleSink, Logger, type LogSink } from './logger';

/**
 * Relays entries to the service worker, which appends them to the rotating log. The
 * popup and options page have no durable storage of their own, and a message can fail
 * (worker asleep, page closing) — {@link Logger} swallows sink errors, so a lost log
 * line never breaks the UI action being logged.
 */
function backgroundSink(): LogSink {
  return {
    async write(entry) {
      const request: SyncRequest = { type: 'log', entry };
      await browser.runtime.sendMessage(request);
    },
  };
}

/** Logger for a UI context; writes to the console and to the worker's rotating log. */
export function createUiLogger(scope: 'popup' | 'options'): Logger {
  return new Logger({ scope, sinks: [backgroundSink(), consoleSink()] });
}
