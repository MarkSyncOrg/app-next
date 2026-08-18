import type {
  Backup,
  Bookmark,
  BookmarkMetadata,
  ServiceInfo,
  Settings,
  SyncDirection,
  SyncOutcome,
  SyncStatus,
} from '@marksyncorg/core';
import type { LogEntry } from './logging/log-entry';

// Typed request/response protocol between the popup and the background service worker.

export type SyncRequest =
  | { type: 'getStatus' }
  | { type: 'getServiceInfo'; serviceUrl: string }
  | { type: 'getSyncUsage' }
  // `direction` is stored as the device's setting before the sync is enabled, so the
  // very first exchange already obeys it rather than running two-way and being corrected
  // from the options page afterwards.
  | { type: 'enableNewSync'; serviceUrl: string; password: string; direction: SyncDirection }
  | {
      type: 'enableExistingSync';
      serviceUrl: string;
      syncId: string;
      password: string;
      direction: SyncDirection;
    }
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
  | { type: 'getBookmarkMetadata'; url: string }
  | { type: 'setBookmarkMetadata'; url: string; description: string; tags: string[] }
  | { type: 'addBookmark'; url: string; title: string; description: string; tags: string[] }
  // Relays a log entry from the popup/options page into the worker's rotating log,
  // so UI activity and background activity share one chronological trace.
  | { type: 'log'; entry: LogEntry };

export type SyncRequestType = SyncRequest['type'];

/** The description and tags held for one URL, and whether it is bookmarked at all. */
export interface BookmarkMetadataResult extends BookmarkMetadata {
  /** Whether the URL is bookmarked in a synced container. */
  bookmarked: boolean;
  /** Title of the bookmark, when there is one. */
  title?: string;
  /** How many bookmarks share this URL; metadata is written to all of them. */
  matches: number;
}

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
  getBookmarkMetadata: BookmarkMetadataResult;
  setBookmarkMetadata: null;
  addBookmark: null;
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
  'getBookmarkMetadata',
  'setBookmarkMetadata',
  'addBookmark',
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
