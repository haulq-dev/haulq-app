/**
 * An invitation, just made, handed to the person who made it. The API
 * returns the token once and keeps only its hash, so this stays on screen
 * until dismissed and says so. Losing it means withdrawing and inviting again.
 *
 * It goes out as a link through the share sheet (Messages, WhatsApp, Mail).
 * `/invite/:token` opens in the app or in a browser, whichever the person
 * has. That replaces the raw code the first `InviteDriver` screen showed.
 */

import { invitationLink } from '@haulq/client';
import { useState } from 'react';
import { shareOrCopy, WEB_ORIGIN } from '../lib/share.ts';

export function InviteLink({ email, token, onDone }: { email: string; token: string; onDone: () => void }) {
  const link = invitationLink(WEB_ORIGIN, token);
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="hq-card space-y-3 bg-brand-50 p-4 shadow-none">
      <p className="font-semibold">Send this link to {email}</p>
      <p className="text-sm text-slate">
        It's shown only now. If it gets lost, withdraw the invitation and send a new one.
      </p>
      <code className="num block break-all rounded-[var(--radius-sm)] bg-card px-3 py-2 text-xs">{link}</code>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="hq-btn hq-btn-primary flex-1"
          onClick={async () => {
            const r = await shareOrCopy({ title: 'Join on HaulQ', text: "You're invited to HaulQ:", url: link });
            setResult(r === 'copied' ? 'Copied' : r === 'shared' ? 'Sent' : null);
          }}
        >
          Share the link
        </button>
        <button type="button" className="hq-btn hq-btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
      {result && <p className="text-sm text-ok">{result}</p>}
    </div>
  );
}
