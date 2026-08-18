import type {
  Backup,
  Bookmark,
  ServiceInfo,
  Settings,
  SyncOutcome,
  SyncStatus,
} from '@marksyncorg/core';
import type { LogEntry } from './logging/log-entry';

// Typed request/response protocol between the popup and the background service worker.

export type SyncRequest =
  | { type: 'getStatus' }
  | { type: 'getServiceInfo'; serviceUrl: string }
  | { type: 'getSyncUsage' }
  | { type: 'enableNewSync'; serviceUrl: string; password: string }
  | { type: 'enableExistingSync'; serviceUrl: string; syncId: string; password: string }
  | { type: 'sync' }
  | { type: 'forcePull' }
  | { type: 'forcePush' }
  | { type: 'disable' }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Partial<Settings> }
  | { type: 'getLog' }
  | { type: 'clearLog' }
  | { type: 'createBackup' }
  | { type: 'restoreBackup'; bookmarks: Bookmark[] }
  // Relays a log entry from the popup/options page into the worker's rotating log,
  // so UI activity and background activity share one chronological trace.
  | { type: 'log'; entry: LogEntry };

export type SyncRequestType = SyncRequest['type'];

/** Maps each request type to its success payload. */
export interface SyncResultData {
  getStatus: SyncStatus;
  getServiceInfo: ServiceInfo;
  getSyncUsage: { usedBytes: number };
  enableNewSync: { syncId: string };
  enableExistingSync: null;
  sync: { outcome: SyncOutcome };
  forcePull: null;
  forcePush: null;
  disable: null;
  getSettings: Settings;
  setSettings: Settings;
  getLog: LogEntry[];
  clearLog: null;
  createBackup: Backup;
  restoreBackup: null;
  log: null;
}

export type SyncResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { name: string; message: string } };

const REQUEST_TYPES: readonly SyncRequestType[] = [
  'getStatus',
  'getServiceInfo',
  'getSyncUsage',
  'enableNewSync',
  'enableExistingSync',
  'sync',
  'forcePull',
  'forcePush',
  'disable',
  'getSettings',
  'setSettings',
  'getLog',
  'clearLog',
  'createBackup',
  'restoreBackup',
  'log',
];

/** Narrows an unknown runtime message to a SyncRequest. */
export function isSyncRequest(message: unknown): message is SyncRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    REQUEST_TYPES.includes((message as { type: SyncRequestType }).type)
  );
}
