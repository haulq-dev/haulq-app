/**
 * Review a rate confirmation that HaulQ read as a load, and make the load.
 * `FEATURE_REQUESTS_PLAN.md` section 12, R2.
 *
 * The document is on the left and the load HaulQ read from it is on the right,
 * every field editable and every field that was read showing the exact text it
 * came from. That is the point: a person can check a value against the page in a
 * glance, and a value HaulQ could not find is marked, not silently blank or
 * silently defaulted. Nothing is created until they press the button, and the
 * load is made from *this form*, not from what was read.
 *
 * Two situations are handled in the open rather than hidden. A broker load
 * number that already belongs to a load is offered as "attach to that load"
 * first, since a rate confirmation carrying an existing number is usually that
 * load's paperwork or a reissue. And a proposal someone else already dealt with
 * says so, with a link to what became of it: the email links here, and it may be
 * a while before anyone follows it.
 */

import {
  blankStop,
  createBodyFromForm,
  EQUIPMENT_OPTIONS,
  evidenceFor,
  formatCents,
  formFromProposal,
  formProblems,
  gapSentence,
  proposalLane,
  useApiClient,
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
import { useEffect, useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Pill } from '../components/ui.tsx';
import { ApiRequestError } from '../lib/api.ts';

/** The rate confirmation itself, fetched with the tenant header, so it cannot be a plain link. */
function DocumentFrame({ documentId, filename }: { documentId: string; filename: string | null }) {
  const client = useApiClient();
  const [state, setState] = useState<{ url: string; image: boolean } | { error: unknown } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setState(null);
    client
      .requestBlob(`/v1/documents/${documentId}/content`)
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setState({ url: made, image: blob.type.startsWith('image/') });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ error });
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [client, documentId]);

  if (state === null) return <Empty>Loading the rate confirmation…</Empty>;
  if ('error' in state) return <ErrorNote error={state.error} />;
  return state.image ? (
    <img src={state.url} alt={filename ?? 'Rate confirmation'} className="max-h-[44rem] w-full border border-line object-contain" />
  ) : (
    <iframe src={state.url} title={filename ?? 'Rate confirmation'} className="h-[44rem] w-full border border-line" />
  );
}

/** Where a value came from, in the document's own words. Only shown for a value that was read. */
function Evidence({ view, path }: { view: LoadProposalView; path: string }) {
  const text = evidenceFor(view, path);
  return text ? <span className="mt-1 block text-xs text-mute">From the document: “{text}”</span> : null;
}

/** A field HaulQ could not find, marked so it is filled in on purpose. */
function NotFound({ show }: { show: boolean }) {
  return show ? <span className="mt-1 block text-xs text-warn">Not found on the document. Fill it in.</span> : null;
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
    <fieldset className="space-y-3 border border-line bg-wash p-3" aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="field-label text-brand">{label}</span>
          <select
            className="hq-input w-auto py-1 text-sm"
            aria-label={`${label} type`}
            value={stop.type}
            onChange={(e) => set('type', e.target.value as 'pickup' | 'delivery')}
          >
            <option value="pickup">Pickup</option>
            <option value="delivery">Delivery</option>
          </select>
        </div>
        <button type="button" className="text-sm text-bad underline" onClick={onRemove}>
          Remove
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Facility">
          <input className="hq-input" value={stop.facilityName} onChange={(e) => set('facilityName', e.target.value)} />
        </Field>
        <Field label="Street address">
          <input className="hq-input" value={stop.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} />
        </Field>
        <Field label="City">
          <input className="hq-input" value={stop.city} onChange={(e) => set('city', e.target.value)} aria-invalid={stop.city.trim() === ''} />
        </Field>
        <div className="grid grid-cols-[5rem_1fr] gap-3">
          <Field label="State">
            <input
              className="hq-input uppercase"
              maxLength={2}
              value={stop.state}
              onChange={(e) => set('state', e.target.value.toUpperCase())}
              aria-invalid={!/^[A-Za-z]{2}$/.test(stop.state)}
            />
          </Field>
          <Field label="ZIP">
            <input className="hq-input" value={stop.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
          </Field>
        </div>
      </div>

      <Evidence view={view} path={`stops.${index}.city`} />
      {stop.appointmentText && (
        <p className="text-xs text-slate">
          Appointment as printed: <span className="num">{stop.appointmentText}</span>
          {stop.windowStart ? (
            <span className="ml-2 text-ok">Set as a window.</span>
          ) : (
            <span className="ml-2 text-warn">Not set as a window; it is in the comments. Set the window on the load’s stops.</span>
          )}
        </p>
      )}
    </fieldset>
  );
}

/** What to do with a proposal nobody can create a load from any more. */
function Settled({ view }: { view: LoadProposalView }) {
  const propose = useProposeLoad();
  const navigate = useNavigate();

  return (
    <Card title="This rate confirmation has been dealt with">
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
          <p className="text-sm text-slate">HaulQ could not read this one as a load. You can try again, or create the load yourself.</p>
          <button
            type="button"
            className="hq-btn hq-btn-brand"
            disabled={propose.isPending}
            onClick={() => propose.mutate(view.documentId, { onSuccess: (next) => void navigate({ to: '/proposals/$proposalId', params: { proposalId: next.id } }) })}
          >
            {propose.isPending ? 'Reading…' : 'Read it again'}
          </button>
          <ErrorNote error={propose.error} />
        </div>
      )}
      <p className="mt-4">
        <Link to="/proposals" className="text-sm text-brand underline">
          Back to rate confirmations
        </Link>
      </p>
    </Card>
  );
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

  const goToLoad = (loadId: string) => void navigate({ to: '/loads/$loadId', params: { loadId } });
  const submit = (confirmDuplicate: boolean) =>
    create.mutate({ id: view.id, body: createBodyFromForm(form, { confirmDuplicate }) }, { onSuccess: (done) => goToLoad(done.load.id) });

  // The reader already says a matched load is a possible duplicate; the banner
  // below says it better, so that note is not repeated in the list.
  const notes = view.notes.filter((n) => !/already has this broker load number/.test(n));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-2">
        <h2 className="field-label text-mute">The rate confirmation</h2>
        <DocumentFrame documentId={view.documentId} filename={view.filename} />
      </div>

      <div className="space-y-5">
        {view.matchedLoad && (
          <div className="border-l-2 border-warn bg-warn-50 px-4 py-3">
            <p className="font-semibold text-warn">Load {view.matchedLoad.reference} already has this broker load number.</p>
            <p className="mt-1 text-sm text-slate">
              This is probably that load’s paperwork, or a reissue of it, and not a new load. Attaching it checks the rate against the load.
            </p>
            <button
              type="button"
              className="hq-btn hq-btn-primary mt-3"
              disabled={busy}
              onClick={() => attach.mutate({ id: view.id, loadId: view.matchedLoad!.id }, { onSuccess: (done) => goToLoad(done.load.id) })}
            >
              {attach.isPending ? 'Attaching…' : `Attach to Load ${view.matchedLoad.reference}`}
            </button>
            <ErrorNote error={attach.error} />
          </div>
        )}

        {(gaps || notes.length > 0) && (
          <div className="space-y-1 border-l-2 border-warn bg-warn-50 px-4 py-3 text-sm text-warn">
            {gaps && <p>{gaps}</p>}
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}

        <Card title="The load">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Field label="Broker">
                <input className="hq-input" value={form.brokerName} onChange={(e) => set('brokerName', e.target.value)} />
              </Field>
              <Evidence view={view} path="broker.name" />
              <NotFound show={!view.load.brokerName} />
            </div>
            <div>
              <Field label="Broker’s load number">
                <input className="hq-input" value={form.brokerLoadNumber} onChange={(e) => set('brokerLoadNumber', e.target.value)} />
              </Field>
              <Evidence view={view} path="brokerLoadNumber" />
              <NotFound show={!view.load.brokerLoadNumber} />
            </div>
            <div>
              <Field label="Rate (USD)">
                <input className="hq-input" inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} />
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
            <div>
              <Field label="Weight (lbs)">
                <input className="hq-input" inputMode="numeric" value={form.weightLbs} onChange={(e) => set('weightLbs', e.target.value)} />
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
        </Card>

        <Card title="Stops">
          <div className="space-y-3">
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
            <div className="flex flex-wrap gap-2">
              <button type="button" className="hq-btn hq-btn-ghost" onClick={() => set('stops', [...form.stops, blankStop('pickup')])}>
                Add a pickup
              </button>
              <button type="button" className="hq-btn hq-btn-ghost" onClick={() => set('stops', [...form.stops, blankStop('delivery')])}>
                Add a delivery
              </button>
            </div>
          </div>
        </Card>

        <Card title="Comments">
          <textarea className="hq-input min-h-24" aria-label="Comments" value={form.comments} onChange={(e) => set('comments', e.target.value)} />
        </Card>

        {problems.length > 0 && (
          <ul className="space-y-1 border-l-2 border-bad bg-bad-50 px-4 py-3 text-sm text-bad" aria-label="What is left to fix">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        {duplicate && (
          <div className="space-y-3 border-l-2 border-warn bg-warn-50 px-4 py-3">
            <p className="text-sm text-warn" role="alert">
              {duplicate.explanation}
            </p>
            <div className="flex flex-wrap gap-2">
              {view.matchedLoad && (
                <button
                  type="button"
                  className="hq-btn hq-btn-primary"
                  disabled={busy}
                  onClick={() => attach.mutate({ id: view.id, loadId: view.matchedLoad!.id }, { onSuccess: (done) => goToLoad(done.load.id) })}
                >
                  Attach to Load {view.matchedLoad.reference} instead
                </button>
              )}
              <button type="button" className="hq-btn hq-btn-ghost" disabled={busy} onClick={() => submit(true)}>
                Create a new load anyway
              </button>
            </div>
          </div>
        )}
        <ErrorNote error={otherError} />

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="hq-btn hq-btn-brand" disabled={busy || problems.length > 0} onClick={() => submit(false)}>
            {create.isPending ? 'Creating…' : 'Create load'}
          </button>
          <button
            type="button"
            className="hq-btn hq-btn-ghost"
            disabled={busy}
            onClick={() => dismiss.mutate(view.id, { onSuccess: () => void navigate({ to: '/proposals' }) })}
          >
            {dismiss.isPending ? 'Dismissing…' : 'This is not a load'}
          </button>
        </div>
        <ErrorNote error={dismiss.error} />
      </div>
    </div>
  );
}

export function ProposalReviewScreen() {
  const { proposalId } = useParams({ from: '/proposals/$proposalId' });
  const session = useSession();
  const orgs = useOrgs();
  const role = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canDispatch = role === 'owner' || role === 'dispatcher';
  const proposal = useLoadProposal(proposalId, { enabled: canDispatch });

  if (orgs.isLoading) return <p className="text-mute">Loading…</p>;
  if (!canDispatch) {
    return (
      <div className="space-y-2">
        <h1 className="text-3xl">Rate confirmation</h1>
        <p className="text-slate">Creating a load from a rate confirmation is for owners and dispatchers.</p>
      </div>
    );
  }

  const view = proposal.data;
  return (
    <div className="space-y-6">
      <div>
        <Link to="/proposals" className="text-sm text-brand underline">
          ← Rate confirmations
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl">{view?.filename ?? 'Rate confirmation'}</h1>
          {view && view.status === 'pending' && <Pill tone="warn">Ready to review</Pill>}
        </div>
        {view && view.status === 'pending' && (
          <p className="mt-1 max-w-prose text-slate">
            HaulQ read this as {proposalLane(view.load) ?? 'a load'}. Check it against the document, fix anything wrong, then create the load. Nothing is
            created until you do.
          </p>
        )}
      </div>

      {proposal.isLoading && <p className="text-mute">Loading…</p>}
      {proposal.isError && <ErrorNote error={proposal.error} />}
      {view && view.status === 'pending' && <Review key={view.id} view={view} />}
      {view && view.status !== 'pending' && <Settled view={view} />}
    </div>
  );
}
