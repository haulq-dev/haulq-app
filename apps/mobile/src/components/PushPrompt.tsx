/**
 * Asking for notifications, at a moment that explains itself: on the loads
 * screen someone just signed in to, with a line saying what they're for.
 * Never at cold launch, and never again after "Not now" (the settings screen
 * still has the switch). iOS asks only once; a second system prompt can't be
 * shown, so the card is only offered while the answer is still open.
 */

import { useEffect, useState } from 'react';
import { askForPush, dismissPrompt, promptDismissed, pushPermission } from '../lib/push.ts';

export function PushPrompt({ forDriver }: { forDriver: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (promptDismissed()) return;
    void pushPermission().then((p) => {
      if (!cancelled) setShow(p === 'prompt');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div className="hq-card space-y-3 p-4">
      <p className="font-semibold">Get notified</p>
      <p className="text-sm text-slate">
        {forDriver
          ? "HaulQ can tell you when you're assigned a load."
          : 'HaulQ can tell you when a load goes quiet, detention starts, a document doesn’t match, or messages are waiting for your OK.'}{' '}
        You choose which in Notifications.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="hq-btn hq-btn-primary flex-1"
          onClick={async () => {
            await askForPush();
            setShow(false);
          }}
        >
          Turn on
        </button>
        <button
          type="button"
          className="hq-btn hq-btn-ghost"
          onClick={() => {
            dismissPrompt();
            setShow(false);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
