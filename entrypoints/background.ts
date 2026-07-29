import { defineBackground } from '#imports';
import { initSyncController } from '../src/background/sync-controller';

// Manifest V3 background service worker entrypoint.
//
// The worker is ephemeral: Chromium may stop it at any time and restart it on the
// next event. Therefore NO durable state is kept in module scope — everything that
// must survive a restart lives in chrome.storage. The controller re-registers its
// listeners on every wake and reads state from storage on demand.
export default defineBackground(() => {
  initSyncController();
});
