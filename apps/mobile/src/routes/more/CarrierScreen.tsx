/**
 * Carrier and costs: who the carrier is, where paperwork comes in, what a
 * mile costs, and this month's usage. Web's `Profile.tsx` on a phone
 * (MOBILE_PARITY_PLAN.md M5), plus the custom intake address M2 deferred here.
 *
 * **No billing.** Web's Profile has a "Manage billing" button into Stripe's
 * portal. That is purchase management, and it stays off the app entirely
 * (MOBILE_PARITY_PLAN.md section 6, decision 1). The plan's name is on the
 * More screen, read-only, and that's all.
 *
 * Who can edit what follows the API: identity and the intake address are
 * owner/dispatcher (`PATCH /v1/org/profile`), operating costs are
 * owner/accountant (`PUT /v1/org/operating-facts`). Everyone here can read.
 *
 * The cost form runs `validateOperatingFacts` from `@haulq/contracts` on
 * every keystroke, the same function the API runs. Errors block the save;
 * warnings are shown and don't, because a niche operation can legitimately
 * sit outside the usual range.
 */

import { hasErrors, isCompleteForScoring, validateOperatingFacts } from '@haulq/contracts';
import {
  canDispatch,
  canManageMoney,
  factsToForm,
  formToFacts,
  OPERATING_FACT_FIELDS,
  useCarrierProfile,
  useOperatingFacts,
  useSaveOperatingFacts,
  useUpdateProfile,
  USAGE_ROWS,
  useUsage,
  type CarrierProfile,
  type OperatingFactsResponse,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, ErrorNote, Field, Pill } from '../../components/ui.tsx';
import { successFeedback } from '../../lib/haptics.ts';
import { shareOrCopy } from '../../lib/share.ts';

export function CarrierScreen() {
  const role = useSession()?.role;
  const profile = useCarrierProfile();

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <h1 className="text-2xl">Carrier and costs</h1>
      {profile.isError && <ErrorNote error={profile.error} />}
      {profile.data && (
        <>
          <Identity profile={profile.data} canEdit={canDispatch(role)} />
          <IntakeEmail profile={profile.data} canEdit={canDispatch(role)} />
        </>
      )}
      <OperatingCosts canEdit={canManageMoney(role)} />
      <Usage />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY_FIELDS = [
  { key: 'legalName', label: 'Legal name' },
  { key: 'dbaName', label: 'Doing business as', hint: 'Leave blank if the same.' },
  { key: 'mcNumber', label: 'MC number', hint: 'Digits. HaulQ strips any “MC-” prefix.', numeric: true },
  { key: 'usdotNumber', label: 'USDOT number', numeric: true },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State', hint: 'Two letters.' },
] as const;

type IdentityKey = (typeof IDENTITY_FIELDS)[number]['key'];

const identityForm = (profile: CarrierProfile) =>
  Object.fromEntries(IDENTITY_FIELDS.map((f) => [f.key, profile[f.key] ?? ''])) as Record<IdentityKey, string>;

function Identity({ profile, canEdit }: { profile: CarrierProfile; canEdit: boolean }) {
  const save = useUpdateProfile();
  const initial = identityForm(profile);
  const [values, setValues] = useState(initial);

  // Only what changed. Emptied means clear it; legal name can't be emptied.
  const changed: Record<string, string | null> = {};
  for (const f of IDENTITY_FIELDS) {
    const next = f.key === 'state' ? values[f.key].trim().toUpperCase() : values[f.key].trim();
    if (next !== (initial[f.key] ?? '').trim()) changed[f.key] = next === '' ? null : next;
  }
  const invalid =
    (values.legalName.trim() === '' && 'Legal name is needed.') ||
    (values.state.trim() !== '' && !/^[A-Za-z]{2}$/.test(values.state.trim()) && 'State is two letters, like KS.') ||
    null;

  if (!canEdit) {
    return (
      <Card title="Carrier">
        <dl className="space-y-2">
          {IDENTITY_FIELDS.map((f) => (
            <div key={f.key} className="flex items-baseline justify-between gap-3">
              <dt className="field-label">{f.label}</dt>
              <dd className={`text-right text-sm ${'numeric' in f ? 'num' : ''}`}>{profile[f.key] ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }

  return (
    <Card title="Carrier">
      <p className="mb-3 text-sm text-slate">Your MC or USDOT number lets HaulQ check broker authority for you, and goes on messages brokers get.</p>
      <div className="space-y-3">
        {IDENTITY_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} {...('hint' in f ? { hint: f.hint } : {})}>
            <input
              className={`hq-input ${'numeric' in f ? 'num' : ''}`}
              {...('numeric' in f ? { inputMode: 'numeric' as const } : {})}
              {...(f.key === 'state' ? { maxLength: 2, autoCapitalize: 'characters' } : {})}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      {invalid && <p className="mt-2 text-sm text-bad">{invalid}</p>}
      <button
        type="button"
        className="hq-btn hq-btn-primary mt-4 w-full"
        disabled={Object.keys(changed).length === 0 || !!invalid || save.isPending}
        onClick={() =>
          save.mutate(changed, {
            // Show what was stored: the API normalises (“MC-123456” → “123456”).
            onSuccess: (saved) => {
              successFeedback();
              setValues(identityForm(saved));
            },
          })
        }
      >
        {save.isPending ? 'Saving…' : 'Save carrier'}
      </button>
      {save.isSuccess && Object.keys(changed).length === 0 && <p className="mt-2 text-center text-sm text-ok">Saved.</p>}
      <div className="mt-2">
        <ErrorNote error={save.error} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Intake address
// ---------------------------------------------------------------------------

/**
 * Where paperwork comes in, and the carrier's own address if they forward
 * one. HaulQ doesn't receive on the carrier's domain; they set up a forward
 * on their mail provider, and this just records what they set up (see web's
 * `CustomEmailPanel` for why).
 */
function IntakeEmail({ profile, canEdit }: { profile: CarrierProfile; canEdit: boolean }) {
  const save = useUpdateProfile();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.customDocsEmail ?? '');
  const [shared, setShared] = useState<string | null>(null);
  if (!profile.slug) return null;
  const address = `docs+${profile.slug}@docs.haulq.ai`;
  const current = profile.customDocsEmail;

  return (
    <Card title="Paperwork email">
      <code className="num block break-all rounded-[var(--radius-sm)] bg-wash px-3 py-2 text-sm">{address}</code>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="hq-btn hq-btn-ghost"
          onClick={async () => {
            const r = await shareOrCopy({ title: 'Send paperwork to HaulQ', text: address });
            setShared(r === 'copied' ? 'Copied' : r === 'shared' ? 'Sent' : null);
          }}
        >
          Share address
        </button>
        {shared && <span className="text-sm text-ok">{shared}</span>}
      </div>

      <div className="mt-4 border-t border-line pt-4">
        {current && !editing && (
          <>
            <p className="text-sm text-slate">
              Mail forwarded from <span className="num">{current}</span> lands here too, as long as the forward is still set
              up on your end.
            </p>
            {canEdit && (
              <button type="button" className="mt-2 text-sm text-brand underline" onClick={() => setEditing(true)}>
                Change or remove
              </button>
            )}
          </>
        )}
        {!current && !editing && canEdit && (
          <button type="button" className="text-sm text-brand underline" onClick={() => setEditing(true)}>
            Use your own address instead
          </button>
        )}
        {editing && (
          <div className="space-y-2">
            <p className="text-sm text-slate">
              Give brokers an address on your own domain, set a forward on your mail provider that sends everything to the
              address above, then enter it here.
            </p>
            <Field label="Your address">
              <input
                className="hq-input"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="docs@yourcompany.com"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <button
                type="button"
                className="hq-btn hq-btn-primary flex-1"
                disabled={!draft.trim() || save.isPending}
                onClick={() => save.mutate({ customDocsEmail: draft.trim() }, { onSuccess: () => setEditing(false) })}
              >
                Save
              </button>
              {current && (
                <button
                  type="button"
                  className="hq-btn hq-btn-ghost text-bad"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ customDocsEmail: null }, { onSuccess: () => { setDraft(''); setEditing(false); } })}
                >
                  Remove
                </button>
              )}
              <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
            <ErrorNote error={save.error} />
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Operating costs
// ---------------------------------------------------------------------------

function OperatingCosts({ canEdit }: { canEdit: boolean }) {
  const saved = useOperatingFacts();
  if (saved.isError) return <ErrorNote error={saved.error} />;
  if (!saved.data) return null;
  return <CostsForm saved={saved.data} canEdit={canEdit} />;
}

function CostsForm({ saved, canEdit }: { saved: OperatingFactsResponse; canEdit: boolean }) {
  const save = useSaveOperatingFacts();
  const [values, setValues] = useState(() => factsToForm(saved.facts));
  const parsed = formToFacts(values);
  const facts = 'facts' in parsed ? parsed.facts : {};
  // The same validator the API runs, live.
  const issues = validateOperatingFacts(facts);
  const blocked = 'invalid' in parsed || hasErrors(issues);
  const general = issues.filter((i) => i.field === 'general');

  return (
    <Card title="What a mile costs you">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-slate">Every margin HaulQ shows is arithmetic on these.</p>
        {isCompleteForScoring(facts) ? <Pill tone="ok">used for margins</Pill> : <Pill tone="warn">using defaults</Pill>}
      </div>

      <div className="space-y-3">
        {OPERATING_FACT_FIELDS.map((f) => {
          const fieldIssues = issues.filter((i) => i.field === f.key);
          const worst = fieldIssues.find((i) => i.severity === 'error') ?? fieldIssues[0];
          const notANumber = 'invalid' in parsed && parsed.invalid === f.key;
          return (
            <div key={f.key}>
              <Field label={f.label} hint={f.hint}>
                <input
                  className="hq-input num"
                  inputMode="decimal"
                  readOnly={!canEdit}
                  aria-invalid={notANumber || worst?.severity === 'error'}
                  value={values[f.key]}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </Field>
              {notANumber && <IssueNote severity="error">That isn't a number.</IssueNote>}
              {!notANumber && worst && <IssueNote severity={worst.severity}>{worst.message}</IssueNote>}
            </div>
          );
        })}
      </div>

      {general.map((i, n) => (
        <IssueNote key={n} severity={i.severity}>
          {i.message}
        </IssueNote>
      ))}

      {canEdit ? (
        <>
          <button
            type="button"
            className="hq-btn hq-btn-brand mt-4 w-full"
            disabled={blocked || save.isPending}
            onClick={() => save.mutate(facts, { onSuccess: successFeedback })}
          >
            {save.isPending ? 'Saving…' : 'Save costs'}
          </button>
          {!blocked && issues.length > 0 && (
            <p className="mt-2 text-center text-sm text-warn">
              {issues.length} {issues.length === 1 ? 'warning' : 'warnings'}. You can still save.
            </p>
          )}
          {save.isSuccess && !save.isPending && <p className="mt-2 text-center text-sm text-ok">Saved.</p>}
          <div className="mt-2">
            <ErrorNote error={save.error} />
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-mute">Only an owner or accountant can change these.</p>
      )}
    </Card>
  );
}

function IssueNote({ severity, children }: { severity: 'error' | 'warning'; children: React.ReactNode }) {
  return (
    <p className={`mt-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs ${severity === 'error' ? 'bg-bad-50 text-bad' : 'bg-warn-50 text-warn'}`}>
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Plain counts. Nothing here is metered or limited, so no "X of Y". */
function Usage() {
  const usage = useUsage();
  if (usage.isError) return <ErrorNote error={usage.error} />;
  if (!usage.data) return null;
  const month = new Date(usage.data.monthStart).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });

  return (
    <Card title={`This month (${month})`}>
      <ul className="space-y-2">
        {USAGE_ROWS.map((row) => (
          <li key={row.key} className="flex items-baseline justify-between gap-3">
            <span className="text-sm">{row.label}</span>
            <span className="num text-lg font-semibold">{usage.data[row.key].toLocaleString('en-US')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
