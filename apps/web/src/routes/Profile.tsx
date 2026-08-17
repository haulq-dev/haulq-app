/**
 * Carrier identity and operating costs.
 *
 * The operating-costs form is the payoff of putting `validateOperatingFacts` in
 * `@haulq/contracts` rather than behind the API: the same function that decides
 * whether a save is allowed runs here on every keystroke, so a carrier sees
 * "fuel alone is $0.50/mi" while typing rather than after submitting.
 *
 * Errors block the save. Warnings do not — they are shown and the button stays
 * live. An owner running a niche operation may legitimately have numbers
 * outside the usual range, and refusing them would make the product useless to
 * him.
 */

import {
  hasErrors,
  isCompleteForScoring,
  validateOperatingFacts,
  type OperatingFacts,
} from '@haulq/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  request,
  type CarrierProfile,
  type OperatingFactsResponse,
} from '../lib/api.ts';
import { Card, ErrorNote, Field, IssueNote, Pill } from '../components/ui.tsx';

/** Dollars in the input, integer cents on the wire. */
const toCents = (text: string): number | undefined => {
  const n = Number(text.replace(/[$,\s]/g, ''));
  return text.trim() === '' || !Number.isFinite(n) ? undefined : Math.round(n * 100);
};
const fromCents = (cents: number | undefined): string =>
  cents === undefined ? '' : (cents / 100).toFixed(2);

const FACT_FIELDS = [
  {
    key: 'costPerMileCents' as const,
    label: 'Cost per mile',
    prefix: '$',
    hint: 'Fuel, maintenance, tyres, tolls. Not driver pay. The single most important number here.',
    money: true,
  },
  {
    key: 'fixedWeeklyCostCents' as const,
    label: 'Fixed cost per week',
    prefix: '$',
    hint: 'Truck payment, insurance, permits, parking — what you owe whether or not the truck moves.',
    money: true,
  },
  {
    key: 'fuelPricePerGallonCents' as const,
    label: 'Diesel per gallon',
    prefix: '$',
    hint: 'What you actually pay, after discounts.',
    money: true,
  },
  {
    key: 'avgMpg' as const,
    label: 'Average mpg',
    prefix: '',
    hint: 'Loaded. A 26 ft straight truck is usually 8 to 10.',
    money: false,
  },
  {
    key: 'driverPayPerMileCents' as const,
    label: 'Driver pay per mile',
    prefix: '$',
    hint: 'Zero if you drive it yourself — your pay is the margin, and counting it twice makes every load look unprofitable.',
    money: true,
  },
  {
    key: 'targetMarginPercent' as const,
    label: 'Target margin',
    prefix: '',
    hint: 'Percent of revenue. Most carriers aim at 15 to 25.',
    money: false,
  },
];

function OperatingCosts() {
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ['operating-facts'],
    queryFn: () => request<OperatingFactsResponse>('/v1/org/operating-facts'),
  });

  const [draft, setDraft] = useState<Record<string, string> | null>(null);

  // Populated from the server once, then owned by the form.
  const values =
    draft ??
    (saved.data
      ? Object.fromEntries(
          FACT_FIELDS.map((f) => [
            f.key,
            f.money
              ? fromCents(saved.data!.facts[f.key])
              : (saved.data!.facts[f.key]?.toString() ?? ''),
          ]),
        )
      : null);

  const facts: OperatingFacts = values
    ? (Object.fromEntries(
        FACT_FIELDS.map((f) => [
          f.key,
          f.money ? toCents(values[f.key] ?? '') : Number(values[f.key]) || undefined,
        ]).filter(([, v]) => v !== undefined),
      ) as OperatingFacts)
    : {};

  // The same validator the API runs. Live, on every keystroke.
  const issues = validateOperatingFacts(facts);
  const blocked = hasErrors(issues);

  const save = useMutation({
    mutationFn: () =>
      request<{ saved: boolean }>('/v1/org/operating-facts', {
        method: 'PUT',
        body: facts,
      }),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  if (saved.isError) return <ErrorNote error={saved.error} />;
  if (!values) return <p className="text-mute">Loading…</p>;

  const issuesFor = (key: string) => issues.filter((i) => i.field === key);

  return (
    <Card
      title="What it costs you to run a mile"
      action={
        isCompleteForScoring(facts) ? (
          <Pill tone="ok">Used for margins</Pill>
        ) : (
          <Pill tone="warn">Using defaults</Pill>
        )
      }
    >
      <p className="mb-5 max-w-prose text-sm text-slate">
        Every profit figure HaulQ shows is arithmetic on these. Until cost per
        mile and fixed weekly cost are both set, margins are estimates built on
        industry defaults rather than your business.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        {FACT_FIELDS.map((f) => {
          const fieldIssues = issuesFor(f.key);
          const worst = fieldIssues.find((i) => i.severity === 'error') ?? fieldIssues[0];

          return (
            <div key={f.key}>
              <Field label={f.label} hint={f.hint}>
                <div className="flex items-center gap-1.5">
                  {f.prefix && <span className="num text-mute">{f.prefix}</span>}
                  <input
                    className="hq-input"
                    data-numeric="true"
                    inputMode="decimal"
                    aria-invalid={fieldIssues.some((i) => i.severity === 'error')}
                    value={values[f.key] ?? ''}
                    onChange={(e) =>
                      setDraft({ ...values, [f.key]: e.target.value })
                    }
                  />
                  {f.key === 'targetMarginPercent' && (
                    <span className="num text-mute">%</span>
                  )}
                </div>
              </Field>
              {worst && (
                <IssueNote severity={worst.severity}>{worst.message}</IssueNote>
              )}
            </div>
          );
        })}
      </div>

      {/* Cross-field problems belong under the form, not beside one input —
          "fuel alone costs more than your stated total" is about three fields
          at once. */}
      {issues.some((i) => i.field === 'general') && (
        <div className="mt-4">
          {issues
            .filter((i) => i.field === 'general')
            .map((i, n) => (
              <IssueNote key={n} severity={i.severity}>
                {i.message}
              </IssueNote>
            ))}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={blocked || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save costs'}
        </button>
        {blocked && (
          <span className="text-sm text-bad">
            Fix the errors above before saving.
          </span>
        )}
        {!blocked && issues.length > 0 && (
          <span className="text-sm text-warn">
            {issues.length} warning{issues.length > 1 ? 's' : ''} — you can still save.
          </span>
        )}
        {save.isSuccess && !save.isPending && (
          <span className="text-sm text-ok">Saved.</span>
        )}
      </div>

      <ErrorNote error={save.error} />
    </Card>
  );
}

function Identity() {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: () => request<CarrierProfile>('/v1/org/profile'),
  });
  const [draft, setDraft] = useState<Partial<CarrierProfile> | null>(null);

  const save = useMutation({
    mutationFn: (body: Partial<CarrierProfile>) =>
      request<CarrierProfile>('/v1/org/profile', { method: 'PATCH', body }),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries();
    },
  });

  if (profile.isError) return <ErrorNote error={profile.error} />;
  if (!profile.data) return <p className="text-mute">Loading…</p>;

  const current = { ...profile.data, ...draft };

  return (
    <Card title="Carrier">
      <p className="mb-5 max-w-prose text-sm text-slate">
        Your MC or USDOT number lets HaulQ check broker authority and insurance
        on your behalf, and goes on messages brokers receive.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Legal name">
          <input
            className="hq-input"
            value={current.legalName ?? ''}
            onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
          />
        </Field>
        <Field label="Doing business as" hint="Leave blank if the same.">
          <input
            className="hq-input"
            value={current.dbaName ?? ''}
            onChange={(e) => setDraft({ ...draft, dbaName: e.target.value })}
          />
        </Field>
        <Field label="MC number" hint="Digits only — HaulQ strips any prefix.">
          <input
            className="hq-input"
            data-numeric="true"
            value={current.mcNumber ?? ''}
            onChange={(e) => setDraft({ ...draft, mcNumber: e.target.value })}
          />
        </Field>
        <Field label="USDOT number">
          <input
            className="hq-input"
            data-numeric="true"
            value={current.usdotNumber ?? ''}
            onChange={(e) => setDraft({ ...draft, usdotNumber: e.target.value })}
          />
        </Field>
        <Field label="City">
          <input
            className="hq-input"
            value={current.city ?? ''}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
          />
        </Field>
        <Field label="State" hint="Two letters.">
          <input
            className="hq-input"
            maxLength={2}
            value={current.state ?? ''}
            onChange={(e) => setDraft({ ...draft, state: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          className="hq-btn hq-btn-primary"
          disabled={!draft || save.isPending}
          onClick={() => draft && save.mutate(draft)}
        >
          {save.isPending ? 'Saving…' : 'Save carrier'}
        </button>
        {save.isSuccess && !draft && <span className="text-sm text-ok">Saved.</span>}
      </div>

      <ErrorNote error={save.error} />
    </Card>
  );
}

export function ProfileScreen() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl">Carrier and costs</h1>
      <Identity />
      <OperatingCosts />
    </div>
  );
}
