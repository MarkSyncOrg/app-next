import type { StorageArea, SyncDirection } from '@marksyncorg/core';
import type { SetupMode } from './setup-direction';

/**
 * Everything the setup form holds, kept only long enough to survive the popup closing.
 *
 * Firefox (and Chrome) close an action popup the instant it loses focus — including when
 * the user switches away to copy a generated sync ID or password out of a password
 * manager, which is exactly when wiping the form hurts the most
 * (https://github.com/MarkSyncOrg/app-next/issues/41). The popup saves this on every
 * change and restores it when it reopens, so that switching away and back does not throw
 * away what was typed.
 */
export interface SetupDraft {
  serviceUrl: string;
  mode: SetupMode;
  syncId: string;
  password: string;
  direction: SyncDirection;
}

const STORAGE_KEY = 'setupDraft';

/**
 * Loads the saved setup draft, or undefined when there is none (a fresh install, or
 * after {@link clearSetupDraft}).
 */
export function loadSetupDraft(storage: StorageArea): Promise<SetupDraft | undefined> {
  return storage.get<SetupDraft>(STORAGE_KEY);
}

/** Saves the setup form's current fields, overwriting whatever draft was there before. */
export function saveSetupDraft(storage: StorageArea, draft: SetupDraft): Promise<void> {
  return storage.set(STORAGE_KEY, draft);
}

/** Discards the draft: called once setup succeeds, so a finished sync leaves nothing behind. */
export function clearSetupDraft(storage: StorageArea): Promise<void> {
  return storage.remove(STORAGE_KEY);
}
