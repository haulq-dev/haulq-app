/**
 * Invite a driver — the second bare-minimum owner action. Two backend
 * calls in sequence, both already existing and already exercised by
 * `apps/web`: `POST /v1/drivers` creates the roster row (`fullName` is its
 * only required field), then `POST /v1/members/invites` sends an invite
 * for that email linked to it via `driverId` — the same linking built for
 * `apps/web/src/routes/Members.tsx`'s own driver picker, which is what
 * lets the invited driver's account see this load once one exists (
 * `driverScopeFor` in `apps/api/src/routes/loads.ts` matches on it).
 *
 * The invite token is shown once, same contract and same reasoning as
 * web's own `TokenPanel` in `Members.tsx` — only its hash is stored, so
 * losing it before copying means inviting again.
 */

import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { request } from '../lib/api.ts';
import { ErrorNote } from '../components/ui.tsx';

interface InviteResult {
  token: string;
}

export function InviteDriverScreen() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: async () => {
      const driver = await request<{ id: string }>('/v1/drivers', { body: { fullName } });
      return request<InviteResult>('/v1/members/invites', {
        body: { email, role: 'driver', driverId: driver.id },
      });
    },
    onSuccess: (res) => setIssued(res.token),
  });

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
    } catch {
      // Clipboard access denied — the token is still selectable text.
    }
  };

  if (issued) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-6">
        <h1 className="text-2xl">Send this to {fullName}</h1>
        <p className="text-sm text-slate">
          This is the only time this code is shown — text or read it to them, and they'll open the
          HaulQ app and enter it to join.
        </p>
        <div className="flex items-center gap-2">
          <code className="num min-w-0 flex-1 border border-line bg-white px-3 py-2 text-xs break-all">
            {issued}
          </code>
          <button type="button" className="hq-btn hq-btn-ghost shrink-0" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <button
          type="button"
          className="hq-btn hq-btn-brand w-full"
          onClick={() => void navigate({ to: '/' })}
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <button className="text-sm text-brand underline" onClick={() => void navigate({ to: '/' })}>
        ← Your loads
      </button>
      <h1 className="text-2xl">Invite a driver</h1>
      <input
        className="hq-input"
        placeholder="Driver's full name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
      />
      <input
        className="hq-input"
        type="email"
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="Their email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={!fullName.trim() || !email.trim() || invite.isPending}
        onClick={() => invite.mutate()}
      >
        {invite.isPending ? 'Sending…' : 'Send invite'}
      </button>
      <ErrorNote error={invite.error} />
    </div>
  );
}
