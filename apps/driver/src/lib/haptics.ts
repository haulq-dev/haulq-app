/**
 * Tap feedback.
 *
 * The single cheapest thing that makes a WebView app stop feeling like a
 * web page in a box — a real UIKit control gives haptic feedback on every
 * tap, and nothing about HTML/CSS produces that for free. Capacitor's web
 * implementation of this plugin is a harmless no-op, so this needs no
 * platform check to stay safe in the browser during `pnpm dev`.
 */

import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/** For a milestone tap, sending a position, anything that just confirmed. */
export function tapFeedback(): void {
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
    // Never worth surfacing — the tap itself already happened.
  });
}

/** For "this just became true" moments — a stop fully checked in, a send that succeeded. */
export function successFeedback(): void {
  void Haptics.notification({ type: NotificationType.Success }).catch(() => {
    tapFeedback();
  });
}
