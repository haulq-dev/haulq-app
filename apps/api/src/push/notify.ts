/**
 * Push to people, from an outbox handler. MOBILE_PARITY_PLAN.md section 7.
 *
 * A second channel on the handlers that already email, not a new pipeline:
 * the handler has resolved who should hear about it (by org membership), and
 * this finds their phones and sends.
 *
 * **Never throws.** Push is best effort alongside email. A handler that threw
 * here would be retried by the outbox, and the retry would email everyone a
 * second time over a push hiccup. A dead token is disabled on the spot; any
 * other failure is logged and dropped. The collapse id means a retry that
 * does happen replaces the notification rather than stacking another.
 */

import { disablePushDevice, pushTargets, type Database } from '@haulq/db';
import type { PushCategory } from '@haulq/contracts';
import { PushError, type PushMessage, type PushSender } from './sender.ts';

export interface PushDeps {
  db: Database;
  /** Unset when APNs isn't configured: every push is then a no-op. */
  push?: PushSender | undefined;
  log: { info: (o: unknown, msg: string) => void; warn: (o: unknown, msg: string) => void };
}

export async function pushToUsers(
  deps: PushDeps,
  input: { userIds: readonly string[]; category: PushCategory; message: PushMessage },
): Promise<{ sent: number; dead: number; failed: number }> {
  const result = { sent: 0, dead: 0, failed: 0 };
  const sender = deps.push;
  if (!sender || input.userIds.length === 0) return result;

  let devices;
  try {
    devices = await pushTargets(deps.db, input.userIds, input.category);
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'push skipped: could not read devices');
    return result;
  }

  for (const device of devices) {
    // An Android token has nowhere to go until an FCM sender exists.
    if (!sender.platforms.includes(device.platform)) continue;
    try {
      const outcome = await sender.send({ token: device.token, platform: device.platform }, input.message);
      if (outcome === 'dead') {
        result.dead += 1;
        await disablePushDevice(deps.db, device.token, 'unregistered');
      } else {
        result.sent += 1;
      }
    } catch (err) {
      result.failed += 1;
      deps.log.warn(
        {
          category: input.category,
          userId: device.userId,
          retryable: err instanceof PushError ? err.retryable : null,
          err: err instanceof Error ? err.message : String(err),
        },
        'push not delivered to one device',
      );
    }
  }

  if (devices.length > 0) {
    deps.log.info({ category: input.category, ...result }, 'push sent');
  }
  return result;
}
