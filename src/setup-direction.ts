import type { SyncDirection } from '@marksyncorg/core';

/** Which half of the setup form the user is filling in. */
export type SetupMode = 'new' | 'existing';

/**
 * What the first exchange will do to each side's bookmarks.
 *
 * Which side survives depends on the direction *and* on whether a sync is being created
 * or joined, and it is the one step the direction setting cannot undo afterwards — so the
 * setup form spells it out rather than leaving the option labels to imply it.
 *
 * Two-way has no entry on purpose. It is the default and the behaviour the extension
 * always had, so a line explaining it would be shown to everyone who never asked for a
 * one-way sync — in a popup already at the browser's height ceiling. The explanation
 * appears when the user departs from the default, which is when it is news.
 */
const SETUP_DIRECTION_HINTS: Record<
  SetupMode,
  Record<Exclude<SyncDirection, 'two-way'>, string>
> = {
  new: {
    'push-only': "This browser's bookmarks start the sync, and it keeps sending them.",
    'pull-only': "This browser's bookmarks start the sync — the last thing it sends.",
  },
  existing: {
    'push-only': 'Careful: replaces the bookmarks already in the sync, on every device.',
    'pull-only': "Replaced by the sync's bookmarks, discarding this browser's.",
  },
};

/**
 * The sentence shown under the setup form's direction selector, or null when there is
 * nothing worth saying — the caller hides the paragraph rather than leaving it blank, so
 * the form does not carry an empty row.
 */
export function setupDirectionHint(mode: SetupMode, direction: SyncDirection): string | null {
  return direction === 'two-way' ? null : SETUP_DIRECTION_HINTS[mode][direction];
}
