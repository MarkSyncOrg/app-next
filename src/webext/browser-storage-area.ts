import { browser } from 'wxt/browser';
import type { StorageArea } from '@marksyncorg/core';

/**
 * StorageArea backed by the extension's `chrome.storage`. The MV3 service worker is
 * ephemeral, so this is the durable home for all sync state. `local` is the default;
 * `sync` could be used for small device-roaming settings.
 */
export function browserStorageArea(area: 'local' | 'sync' = 'local'): StorageArea {
  const storage = browser.storage[area];
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await storage.get(key);
      return result[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await storage.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await storage.remove(key);
    },
  };
}
