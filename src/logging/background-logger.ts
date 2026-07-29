import { browserStorageArea } from '../webext/browser-storage-area';
import { consoleSink, Logger, type LogSink } from './logger';
import { RotatingLogStore } from './rotating-log-store';

/**
 * Logging wiring for the MV3 service worker: entries go to the daily-rotating store
 * (readable/downloadable from the options page) and to the console (visible live in
 * the worker devtools).
 */
export interface BackgroundLog {
  logger: Logger;
  store: RotatingLogStore;
}

function storeSink(store: RotatingLogStore): LogSink {
  return { write: (entry) => store.append(entry) };
}

export function createBackgroundLog(): BackgroundLog {
  const store = new RotatingLogStore(browserStorageArea());
  const logger = new Logger({ sinks: [storeSink(store), consoleSink()] });
  return { logger, store };
}
