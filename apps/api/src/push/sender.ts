/**
 * Sending a push. MOBILE_PARITY_PLAN.md section 7.
 *
 * An interface with a real APNs sender and a fake, the same injected-provider
 * seam as `routingProvider`/`placesProvider`. Direct APNs now, FCM behind the
 * same interface once Android ships. Firebase for both from day one would put
 * its SDK in the iOS app to serve a platform that isn't shipping.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** The in-app path a tap opens: `/loads/:id`, `/autopilot`. */
  path: string;
  /** Which carrier it's about, so a tap can switch to it first. */
  orgId: string;
  /**
   * The outbox message's seq. The outbox delivers at least once, so a
   * redelivery reuses this and replaces the notification on the phone
   * instead of stacking a second one.
   */
  collapseId: string;
}

export interface PushDeviceAddress {
  token: string;
  platform: string;
}

/** `dead`: the token will never work again (uninstalled, or a stale token). Disable it and never retry. */
export type PushOutcome = 'sent' | 'dead';

/** A failure that might succeed later: throttled, the service is down. */
export class PushError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'PushError';
    this.retryable = retryable;
  }
}

export interface PushSender {
  readonly name: string;
  /** Platforms this sender can deliver to. APNs is `ios` only. */
  readonly platforms: readonly string[];
  send(device: PushDeviceAddress, message: PushMessage): Promise<PushOutcome>;
}

/** Records what would have been sent. Tests inject it; `deadTokens` answer `dead`. */
export class FakePushSender implements PushSender {
  readonly name = 'fake';
  readonly platforms = ['ios', 'android'];
  readonly sent: { device: PushDeviceAddress; message: PushMessage }[] = [];
  readonly deadTokens = new Set<string>();

  async send(device: PushDeviceAddress, message: PushMessage): Promise<PushOutcome> {
    if (this.deadTokens.has(device.token)) return 'dead';
    this.sent.push({ device, message });
    return 'sent';
  }
}
