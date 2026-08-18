import { describe, expect, it } from 'vitest';
import type { SyncDirection } from '@marksyncorg/core';
import { type SetupMode, setupDirectionHint } from './setup-direction';

const MODES: SetupMode[] = ['new', 'existing'];
const DIRECTIONS: SyncDirection[] = ['two-way', 'push-only', 'pull-only'];

describe('setupDirectionHint', () => {
  it('has a sentence for every mode and direction', () => {
    for (const mode of MODES) {
      for (const direction of DIRECTIONS) {
        expect(setupDirectionHint(mode, direction)).toMatch(/\S/);
      }
    }
  });

  it('says the sync is seeded from this browser whatever the direction, when creating one', () => {
    // A new sync has to come from somewhere, so even a receive-only device uploads once.
    for (const direction of DIRECTIONS) {
      expect(setupDirectionHint('new', direction)).toContain('start the sync');
    }
  });

  it('warns that joining as send-only overwrites the sync, and only then', () => {
    expect(setupDirectionHint('existing', 'push-only')).toContain('Careful');
    expect(setupDirectionHint('existing', 'push-only')).toContain('will replace the ones already');
    expect(setupDirectionHint('existing', 'two-way')).not.toContain('Careful');
    expect(setupDirectionHint('existing', 'pull-only')).not.toContain('Careful');
  });

  it('says this browser loses its bookmarks when joining a sync to receive from it', () => {
    expect(setupDirectionHint('existing', 'pull-only')).toContain('will be replaced by');
  });

  it('distinguishes creating from joining for every direction', () => {
    // The two halves must never read the same: which side survives is exactly what
    // differs between seeding a sync and joining one that already has bookmarks.
    for (const direction of DIRECTIONS) {
      expect(setupDirectionHint('new', direction)).not.toBe(
        setupDirectionHint('existing', direction),
      );
    }
  });
});
