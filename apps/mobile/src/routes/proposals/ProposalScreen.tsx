/**
 * Review a rate confirmation HaulQ read as a load, and make the load. Web's
 * `ProposalReview.tsx` on a phone (FEATURE_REQUESTS_PLAN.md section 12, R2).
 *
 * Web puts the document beside the form. On a phone they stack: the document
 * first, behind a tap so it doesn't push the form off the screen, then every
 * field editable, each read value showing the exact text it came from, and
 * each value HaulQ couldn't find marked so it's filled in on purpose. Nothing
 * is created until the button is pressed, and the load is made from *this
 * form*, never from what was read (`createBodyFromForm`).
 *
 * Handled in the open, as on web: a broker load number that already belongs
 * to a load is offered as "attach to that load" first, since that's usually
 * its paperwork or a reissue. And a proposal someone already dealt with says
 * so, with a link to what became of it, because the push and the email both
 * link here and may be followed later.
 */

import {
  blankStop,
  canDispatch,
  createBodyFromForm,
  EQUIPMENT_OPTIONS,
  evidenceFor,
  formFromProposal,
  formProblems,
  gapSentence,
  proposalLane,
  useAttachProposal,
  useCreateFromProposal,
  useDismissProposal,
  useLoadProposal,
  useProposeLoad,
  type LoadProposalView,
  type ProposalForm,
  type StopForm,
} from '@haulq/client';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { DocumentPreview } from '../../components/DocumentPreview.tsx';
import { Card, ErrorNote, Field, Note, Pill } from '../../components/ui.tsx';
import { ApiRequestError } from '../../lib/api.ts';
import { successFeedback } from '../../lib/haptics.ts';

export function ProposalScreen() {
  const { proposalId } = useParams({ from: '/proposals/$proposalId' });
  const allowed = canDispatch(useSession()?.role);
  const proposal = useLoadProposal(proposalId, { enabled: allowed });
  const view = proposal.data;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/proposals" className="text-sm text-brand">
        ‹ Rate confirmations
      </Link>
      {!allowed ? (
        <Note>Creating a load from a rate confirmation is for owners and dispatchers.</Note>
      ) : (
        <>
          {proposal.isLoading && <p className="text-sm text-mute">Loading…</p>}
          <ErrorNote error={proposal.error} />
          {view && (
            <header className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-2xl">{view.filename ?? 'Rate confirmation'}</h1>
                {view.status === 'pending' && (
                  <Pill tone="warn" onPage>
                    ready to review
                  </Pill>
                )}
              </div>
              {view.status === 'pending' && (
                <p className="text-sm text-slate">
                  HaulQ read this as {proposalLane(view.load) ?? 'a load'}. Check it against the document, fix anything wrong, then create
                  the load.
                </p>
              )}
            </header>
          )}
          {view && view.status === 'pending' && <Review key={view.id} view={view} />}
          {view && view.status !== 'pending' && <Settled view={view} />}
        </>
      )}
    </div>
  );
}

/** The rate confirmation itself, on demand. Opened by default only when the reader missed something. */
function TheDocument({ view }: { view: LoadProposalView }) {
  const [open, setOpen] = useState(view.gaps.length > 0);
  if (!open) {
    return (
      <button type="button" className="hq-btn hq-btn-ghost w-full" onClick={() => setOpen(true)}>
        Show the rate confirmation
      </button>
    );
  }
  return (
    <Card title="The rate confirmation">
      <DocumentPreview id={view.documentId} contentType={null} filename={view.filename} />
    </Card>
  );
}

/** Where a value came from, in the document's own words. */
function Evidence({ view, path }: { view: LoadProposalView; path: string }) {
  const text = evidenceFor(view, path);
  return text ? <span className="mt-1 block text-xs text-mute">From the document: “{text}”</span> : null;
}

function NotFound({ show }: { show: boolean }) {
  return show ? <span className="mt-1 block text-xs text-warn">Not found on the document. Fill it in.</span> : null;
}

function Review({ view }: { view: LoadProposalView }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<ProposalForm>(() => formFromProposal(view));
  const create = useCreateFromProposal();
  const attach = useAttachProposal();
  const dismiss = useDismissProposal();

  const problems = formProblems(form);
  const set = <K extends keyof ProposalForm>(key: K, value: ProposalForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const gaps = gapSentence(view.gaps);
  const busy = create.isPending || attach.isPending || dismiss.isPending;

  const duplicate = create.error instanceof ApiRequestError && create.error.code === 'duplicate_load_number' ? create.error : null;
  const otherError = duplicate ? null : create.error;

  const goToLoad = (loadId: string) => {
    successFeedback();
    void navigate({ to: '/loads/$loadId', params: { loadId }, replace: true });
  };
  const submit = (confirmDuplicate: boolean) =>
    create.mutate({ id: view.id, body: createBodyFromForm(form, { confirmDuplicate }) }, { onSuccess: (done) => goToLoad(done.load.id) });
  const attachToMatch = () =>
    attach.mutate({ id: view.id, loadId: view.matchedLoad!.id }, { onSuccess: (done) => goToLoad(done.load.id) });

  // The reader's own "possible duplicate" note says what the banner below says better.
  const notes = view.notes.filter((n) => !/already has this broker load number/.test(n));

  return (
    <>
      <TheDocument view={view} />

      {view.matchedLoad && (
        <div className="hq-card space-y-2 bg-warn-50 p-4 shadow-none">
          <p className="font-semibold text-warn">Load {view.matchedLoad.reference} already has this broker load number.</p>
          <p className="text-sm text-slate">
            This is probably that load’s paperwork, or a reissue of it, not a new load. Attaching it checks the rate against the load.
          </p>
          <button type="button" className="hq-btn hq-btn-primary w-full" disabled={busy} onClick={attachToMatch}>
            {attach.isPending ? 'Attaching…' : `Attach to Load ${view.matchedLoad.reference}`}
          </button>
          <ErrorNote error={attach.error} />
        </div>
      )}

      {(gaps || notes.length > 0) && (
        <div className="hq-card space-y-1 bg-warn-50 px-4 py-3 text-sm text-warn shadow-none">
          {gaps && <p>{gaps}</p>}
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}

      <Card title="The load">
        <div className="space-y-4">
          <div>
            <Field label="Broker">
              <input className="hq-input" value={form.brokerName} onChange={(e) => set('brokerName', e.target.value)} />
            </Field>
            <Evidence view={view} path="broker.name" />
            <NotFound show={!view.load.brokerName} />
          </div>
          <div>
            <Field label="Broker’s load number">
              <input className="hq-input num" value={form.brokerLoadNumber} onChange={(e) => set('brokerLoadNumber', e.target.value)} />
            </Field>
            <Evidence view={view} path="brokerLoadNumber" />
            <NotFound show={!view.load.brokerLoadNumber} />
          </div>
          <div>
            <Field label="Rate (USD)">
              <input className="hq-input num" inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} />
            </Field>
            <Evidence view={view} path="rate" />
            <NotFound show={view.load.rateAmount === undefined} />
          </div>
          <div>
            <Field label="Equipment">
              <select className="hq-input" value={form.equipment} onChange={(e) => set('equipment', e.target.value as ProposalForm['equipment'])}>
                <option value="">Choose…</option>
                {EQUIPMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Evidence view={view} path="equipment" />
            <NotFound show={!view.load.equipment} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Field label="Weight (lbs)">
                <input className="hq-input num" inputMode="numeric" value={form.weightLbs} onChange={(e) => set('weightLbs', e.target.value)} />
              </Field>
              <Evidence view={view} path="weightLbs" />
            </div>
            <div>
              <Field label="Commodity">
                <input className="hq-input" value={form.commodity} onChange={(e) => set('commodity', e.target.value)} />
              </Field>
              <Evidence view={view} path="commodity" />
            </div>
          </div>
        </div>
      </Card>

      <Card title="Stops">
        <div className="space-y-4">
          {form.stops.map((stop, i) => (
            <StopEditor
              key={stop.key}
              view={view}
              index={i}
              stop={stop}
              onChange={(next) => set('stops', form.stops.map((s) => (s.key === stop.key ? next : s)))}
              onRemove={() => set('stops', form.stops.filter((s) => s.key !== stop.key))}
            />
          ))}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="hq-btn hq-btn-ghost" onClick={() => set('stops', [...form.stops, blankStop('pickup')])}>
              + Pickup
            </button>
            <button type="button" className="hq-btn hq-btn-ghost" onClick={() => set('stops', [...form.stops, blankStop('delivery')])}>
              + Delivery
            </button>
          </div>
        </div>
      </Card>

      <Card title="Comments">
        <textarea className="hq-input min-h-24" aria-label="Comments" value={form.comments} onChange={(e) => set('comments', e.target.value)} />
      </Card>

      {problems.length > 0 && (
        <ul className="hq-card space-y-1 bg-bad-50 px-4 py-3 text-sm text-bad shadow-none" aria-label="What is left to fix">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {duplicate && (
        <div className="hq-card space-y-2 bg-warn-50 p-4 shadow-none">
          <p className="text-sm text-warn" role="alert">
            {duplicate.explanation}
          </p>
          {view.matchedLoad && (
            <button type="button" className="hq-btn hq-btn-primary w-full" disabled={busy} onClick={attachToMatch}>
              Attach to Load {view.matchedLoad.reference} instead
            </button>
          )}
          <button type="button" className="hq-btn hq-btn-ghost w-full" disabled={busy} onClick={() => submit(true)}>
            Create a new load anyway
          </button>
        </div>
      )}
      <ErrorNote error={otherError} />

      <button type="button" className="hq-btn hq-btn-brand w-full" disabled={busy || problems.length > 0} onClick={() => submit(false)}>
        {create.isPending ? 'Creating…' : 'Create load'}
      </button>
      <button
        type="button"
        className="w-full py-2 text-sm text-mute underline"
        disabled={busy}
        onClick={() => dismiss.mutate(view.id, { onSuccess: () => void navigate({ to: '/proposals', replace: true }) })}
      >
        {dismiss.isPending ? 'Dismissing…' : 'This is not a load'}
      </button>
      <ErrorNote error={dismiss.error} />
    </>
  );
}

function StopEditor({
  view,
  index,
  stop,
  onChange,
  onRemove,
}: {
  view: LoadProposalView;
  index: number;
  stop: StopForm;
  onChange: (next: StopForm) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof StopForm>(key: K, value: StopForm[K]) => onChange({ ...stop, [key]: value });
  const label = `${stop.type === 'pickup' ? 'Pickup' : 'Delivery'} ${index + 1}`;

  return (
    <fieldset className="space-y-3 rounded-[var(--radius-sm)] bg-wash p-3" aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <select
          className="hq-input w-auto py-1.5 text-sm font-semibold"
          aria-label={`${label} type`}
          value={stop.type}
          onChange={(e) => set('type', e.target.value as 'pickup' | 'delivery')}
        >
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
        <button type="button" className="text-sm text-bad underline" onClick={onRemove}>
          Remove
        </button>
      </div>
      <Field label="Facility">
        <input className="hq-input" value={stop.facilityName} onChange={(e) => set('facilityName', e.target.value)} />
      </Field>
      <Field label="Street address">
        <input className="hq-input" value={stop.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} />
      </Field>
      <div className="grid grid-cols-[1fr_4.5rem_5.5rem] gap-2">
        <Field label="City">
          <input className="hq-input" value={stop.city} onChange={(e) => set('city', e.target.value)} aria-invalid={stop.city.trim() === ''} />
        </Field>
        <Field label="State">
          <input
            className="hq-input uppercase"
            maxLength={2}
            autoCapitalize="characters"
            value={stop.state}
            onChange={(e) => set('state', e.target.value.toUpperCase())}
            aria-invalid={!/^[A-Za-z]{2}$/.test(stop.state)}
          />
        </Field>
        <Field label="ZIP">
          <input className="hq-input num" inputMode="numeric" value={stop.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
        </Field>
      </div>
      <Evidence view={view} path={`stops.${index}.city`} />
      {stop.appointmentText && (
        <p className="text-xs text-slate">
          Appointment as printed: <span className="num">{stop.appointmentText}</span>{' '}
          {stop.windowStart ? (
            <span className="text-ok">Set as a window.</span>
          ) : (
            <span className="text-warn">Not set as a window; it’s in the comments. Set it on the load’s stops.</span>
          )}
        </p>
      )}
    </fieldset>
  );
}

/** A proposal nobody can create a load from any more, and what became of it. */
function Settled({ view }: { view: LoadProposalView }) {
  const propose = useProposeLoad();
  const navigate = useNavigate();

  return (
    <Card title="Already dealt with">
      {view.status === 'created' && (
        <p className="text-sm text-slate">
          A load was created from it.{' '}
          {view.createdLoadId && (
            <Link to="/loads/$loadId" params={{ loadId: view.createdLoadId }} className="text-brand underline">
              Open the load
            </Link>
          )}
        </p>
      )}
      {view.status === 'attached' && (
        <p className="text-sm text-slate">
          It was attached to an existing load.{' '}
          {view.matchedLoad && (
            <Link to="/loads/$loadId" params={{ loadId: view.matchedLoad.id }} className="text-brand underline">
              Open Load {view.matchedLoad.reference}
            </Link>
          )}
        </p>
      )}
      {view.status === 'dismissed' && <p className="text-sm text-slate">It was dismissed: not a load to create.</p>}
      {view.status === 'unreadable' && (
        <div className="space-y-3">
          <p className="text-sm text-slate">HaulQ couldn’t read this one as a load. Try again, or create the load yourself.</p>
          <button
            type="button"
            className="hq-btn hq-btn-brand w-full"
            disabled={propose.isPending}
            onClick={() =>
              propose.mutate(view.documentId, {
                onSuccess: (next) => void navigate({ to: '/proposals/$proposalId', params: { proposalId: next.id }, replace: true }),
              })
            }
          >
            {propose.isPending ? 'Reading…' : 'Read it again'}
          </button>
          <ErrorNote error={propose.error} />
        </div>
      )}
    </Card>
  );
}
