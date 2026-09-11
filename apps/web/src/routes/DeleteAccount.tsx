/**
 * Account deletion — Apple's Guideline 5.1.1(v): any app that supports
 * account creation must also offer a way to delete one, in-app or via a
 * link to a web page that handles it. This is that web page; the driver
 * app links here (`DeleteAccountLink` in its own `AuthGate.tsx`) rather
 * than reimplementing it, since both apps share the same Clerk identity.
 *
 * `user.delete()` is Clerk's own self-service method — a signed-in person
 * deleting themselves, not an admin action. Deleting the Clerk user fires
 * the `user.deleted` webhook (`apps/api/src/routes/webhooks.ts`), which
 * deliberately does not remove the local `users` row — it's referenced by
 * `event_log.actor_user_id`, and an audit trail with its actors erased
 * stops being an audit trail (guardrail 6). What actually happens: the
 * Clerk identity is gone, so this person can never sign in again, which
 * is what "delete your account" means from where they're standing. It
 * does not touch their carrier's own records (loads, invoices, other
 * members) — same as removing any team member today.
 */

import { useUser } from '@clerk/clerk-react';
import { useState } from 'react';
import { ErrorNote } from '../components/ui.tsx';

export function DeleteAccountScreen() {
  const { user, isLoaded } = useUser();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await user?.delete();
      setDone(true);
    } catch (err) {
      setError(err);
      setDeleting(false);
    }
  };

  if (done) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-2 text-2xl">Your account has been deleted</h1>
        <p className="text-slate">You can close this page.</p>
      </div>
    );
  }

  if (!isLoaded) {
    return <div className="mx-auto max-w-md px-6 py-16 text-mute">Loading…</div>;
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-2 text-2xl">Sign in to delete your account</h1>
        <p className="text-slate">This page needs to know who you are before it can do that.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-2 text-2xl">Delete your account</h1>
      <p className="mb-4 text-slate">
        This permanently deletes your HaulQ sign-in ({user.primaryEmailAddress?.emailAddress}) —
        you won't be able to sign in again with it. It does not delete your carrier's own records:
        loads, invoices, and other members' access stay exactly as they are, the same as removing
        any one member today.
      </p>

      {!confirming ? (
        <button
          type="button"
          className="hq-btn hq-btn-ghost text-bad"
          onClick={() => setConfirming(true)}
        >
          Delete my account
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-medium text-bad">Are you sure? This cannot be undone.</p>
          <div className="flex gap-3">
            <button
              type="button"
              className="hq-btn bg-bad text-white"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? 'Deleting…' : 'Yes, delete my account'}
            </button>
            <button
              type="button"
              className="hq-btn hq-btn-ghost"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ErrorNote error={error} />
    </div>
  );
}
