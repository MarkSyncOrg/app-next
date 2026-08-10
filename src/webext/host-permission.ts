import { normalizeServiceUrl } from '@marksyncorg/core';
import { Logger } from '../logging/logger';

/** The slice of `browser.permissions` this gate uses. */
export interface PermissionsApi {
  getAll(): Promise<{ origins?: string[] }>;
  request(permissions: { origins: string[] }): Promise<boolean>;
}

/** The origin pattern the extension needs in order to reach `serviceUrl`. */
export function serviceOrigin(serviceUrl: string): string {
  return `${new URL(normalizeServiceUrl(serviceUrl)).origin}/*`;
}

/**
 * Grants the extension access to a custom (self-hosted or third-party) service.
 *
 * Only `https://api.xbrowsersync.org/*` is granted at install; every other service is
 * covered by the optional wildcard host pattern (any https origin) and has to be granted
 * by the user when they enable sync against it.
 *
 * Firefox accepts `permissions.request()` only while it is still handling the user
 * input that led to the call — it reads the flag per API call, and a promise that
 * crosses to the parent process resolves in a later task, by which point the gesture is
 * gone ("permissions.request may only be called from a user input handler"). Chrome's
 * transient activation window is seconds long and hides the problem entirely, so an
 * `await` in front of the request looks harmless and breaks only Firefox — and only for
 * custom services, since the official host never reaches the request at all.
 *
 * That is why "do we already have this origin?" is answered from a snapshot taken by
 * {@link refresh} instead of from `permissions.contains()`: {@link ensure} runs straight
 * through to the request without awaiting anything, so it can be called from a submit
 * handler and still count as a user gesture.
 */
export class HostPermissionGate {
  private granted: string[] = [];

  constructor(
    private readonly permissions: PermissionsApi,
    private readonly log: Logger = new Logger(),
  ) {}

  /**
   * Snapshots the host patterns the extension already holds. Must have resolved before
   * the first {@link ensure} call, which cannot await it.
   */
  async refresh(): Promise<void> {
    this.granted = (await this.permissions.getAll()).origins ?? [];
    await this.log.debug('Read the granted host permissions', { count: this.granted.length });
  }

  /**
   * Ensures the extension may reach `serviceUrl`, requesting the host permission when
   * it is not held yet. Call it directly from the event handler of the user action that
   * needs it, before awaiting anything — see the class comment.
   *
   * The URL goes through core's `normalizeServiceUrl`, the same check the API client
   * applies before every request (HTTPS bar loopback, no query, no fragment, no embedded
   * credentials), so a bad URL is refused with a readable message here rather than a
   * round trip later, and there is one definition of a valid service URL, not two.
   */
  ensure(serviceUrl: string): Promise<void> {
    let origin: string;
    try {
      origin = serviceOrigin(serviceUrl);
    } catch (error) {
      void this.log.warn('Refused an unusable service URL', {
        serviceUrl,
        errorMessage: (error as Error).message,
      });
      return Promise.reject(error instanceof Error ? error : new Error('Invalid service URL'));
    }
    if (this.granted.includes(origin)) {
      void this.log.debug('Host permission already granted', { origin });
      return Promise.resolve();
    }
    // Only `https://*/*` is declared as optional, so a plaintext origin can only ever be
    // one granted at install (WXT_EXTRA_HOST, for local testing) — which the snapshot
    // above would have matched. Requesting it would fail with the browser's own wording
    // about undeclared optional permissions; say what is actually wrong instead.
    if (!origin.startsWith('https://')) {
      void this.log.warn('Refused a plaintext service URL', { origin });
      return Promise.reject(new Error('Only https services can be added'));
    }
    void this.log.info('Requesting host permission', { origin });
    // Nothing above this line awaits, and nothing that awaits may be added: the request
    // has to be issued in the same task as the user gesture (see the class comment).
    return this.permissions.request({ origins: [origin] }).then(async (granted) => {
      if (!granted) {
        await this.log.warn('Host permission denied by the user', { origin });
        throw new Error('Permission to access this service was denied');
      }
      this.granted = [...this.granted, origin];
      await this.log.info('Host permission granted', { origin });
    });
  }
}
