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
 *
 * The same popup-closes-on-blur behaviour also fires the instant the browser shows its
 * own "allow this site?" prompt for a custom service, since that prompt takes focus away
 * from the popup too — but there the permission grant itself still goes through at the
 * browser level, only the popup's own JavaScript (and the enable request it was about to
 * send) gets cut off. `pending` marks a draft saved right before that request, so the
 * next popup open can tell "submitted, then interrupted" apart from "still being typed"
 * and finish the job instead of leaving the user staring at a form that looks untouched.
 */
export interface SetupDraft {
  serviceUrl: string;
  mode: SetupMode;
  syncId: string;
  password: string;
  direction: SyncDirection;
  pending?: boolean;
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
