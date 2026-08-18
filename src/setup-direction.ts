import type { SyncDirection } from '@marksyncorg/core';

/** Which half of the setup form the user is filling in. */
export type SetupMode = 'new' | 'existing';

/**
 * What the first exchange will do to each side's bookmarks.
 *
 * Which side survives depends on the direction *and* on whether a sync is being created
 * or joined, and it is the one step the direction setting cannot undo afterwards — so the
 * setup form spells it out rather than leaving the option labels to imply it.
 */
const SETUP_DIRECTION_HINTS: Record<SetupMode, Record<SyncDirection, string>> = {
  new: {
    'two-way': "This browser's bookmarks start the sync, and it then sends and receives.",
    'push-only': "This browser's bookmarks start the sync, and it keeps sending them.",
    'pull-only':
      "This browser's bookmarks start the sync — the last thing it sends. After that it only receives.",
  },
  existing: {
    'two-way': "This browser's bookmarks will be merged with the ones already in the sync.",
    'push-only':
      "Careful: this browser's bookmarks will replace the ones already in the sync, on every device.",
    'pull-only': "This browser's bookmarks will be replaced by the ones already in the sync.",
  },
};

/** The sentence shown under the setup form's direction selector. */
export function setupDirectionHint(mode: SetupMode, direction: SyncDirection): string {
  return SETUP_DIRECTION_HINTS[mode][direction];
}
