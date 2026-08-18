/**
 * The import wizard.
 *
 * Mirrors the API's staging exactly — upload, map, review, commit — because the
 * whole reason the pipeline is staged is that a carrier gets to see the damage
 * before anything is written. A UI that collapsed those steps into one button
 * would throw away the property the backend was built for.
 *
 * The mapping step shows five real rows beside the guessed columns. That is the
 * single most important thing on this screen: a column called "Rate" might be
 * linehaul or all-in, and a wrong guess produces an import that looks perfect
 * and is wrong by the fuel surcharge on every load.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  request,
  type HistorySummary,
  type ImportBatch,
  type ImportRow,
  type OperatingFactsResponse,
  type UploadResponse,
} from '../lib/api.ts';
import { Card, Empty, ErrorNote, Money, Num, Pill } from '../components/ui.tsx';

const FIELDS = [
  ['', 'Ignore this column'],
  ['reference', 'Load number'],
  ['brokerName', 'Broker'],
  ['brokerLoadNumber', "Broker's load number"],
  ['origin', 'Origin (city and state)'],
  ['originCity', 'Origin city'],
  ['originState', 'Origin state'],
  ['destination', 'Destination (city and state)'],
  ['destCity', 'Destination city'],
  ['destState', 'Destination state'],
  ['pickupDate', 'Pickup date'],
  ['deliveryDate', 'Delivery date'],
  ['rate', 'Rate'],
  ['loadedMiles', 'Loaded miles'],
  ['deadheadMiles', 'Deadhead miles'],
  ['weightLbs', 'Weight'],
  ['commodity', 'Commodity'],
  ['truckLabel', 'Truck'],
  ['notes', 'Notes'],
] as const;

type Stage =
  | { name: 'upload' }
  | { name: 'mapping'; upload: UploadResponse }
  | { name: 'review'; batch: ImportBatch; invalidRows: ImportRow[] }
  | { name: 'done'; committed: number; skipped: number };

function UploadStep({ onUploaded }: { onUploaded: (u: UploadResponse) => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const send = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      // Posted as a raw body rather than multipart — a browser can send a File
      // directly, and this endpoint takes exactly one file, never a mixed form.
      const res = await request<UploadResponse>(
        `/v1/imports?filename=${encodeURIComponent(file.name)}`,
        { raw: { body: file, contentType: 'text/csv' } },
      );
      onUploaded(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Import your load history">
      <p className="mb-5 max-w-prose text-sm text-slate">
        Export 30 to 90 days of past loads from whatever you use now and drop the
        file here. HaulQ works out the columns, shows you what it could not read,
        and writes nothing until you say so.
      </p>

      <label className="block cursor-pointer border-2 border-dashed border-line bg-wash p-10 text-center hover:border-brand">
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void send(file);
          }}
        />
        <span className="block text-lg">
          {busy ? 'Reading…' : 'Choose a CSV file'}
        </span>
        <span className="mt-1 block text-sm text-mute">
          Messy is fine — title rows, mixed date formats, a totals row at the bottom.
        </span>
      </label>

      <ErrorNote error={error} />
    </Card>
  );
}

function MappingStep({
  upload,
  onMapped,
}: {
  upload: UploadResponse;
  onMapped: (batch: ImportBatch, invalidRows: ImportRow[]) => void;
}) {
  const [mapping, setMapping] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(upload.suggestedMapping.map((g) => [g.header, g.field])),
  );

  const confirm = useMutation({
    mutationFn: () =>
      request<{ batch: ImportBatch; invalidRows: ImportRow[] }>(
        `/v1/imports/${upload.batch.id}/mapping`,
        { method: 'PUT', body: mapping },
      ),
    onSuccess: (res) => onMapped(res.batch, res.invalidRows),
  });

  const lowConfidence = new Set(
    upload.suggestedMapping.filter((g) => g.field && g.confidence < 0.6).map((g) => g.header),
  );

  return (
    <Card title={`Match the columns in ${upload.batch.filename}`}>
      <p className="mb-5 max-w-prose text-sm text-slate">
        HaulQ has guessed these from your headers. Check them against the sample
        values — the guesses are usually right, and a wrong one is invisible
        afterwards.
      </p>

      <div className="overflow-x-auto">
        <table className="hq-table">
          <thead>
            <tr>
              <th className="field-label">Your column</th>
              <th className="field-label">Sample values</th>
              <th className="field-label">HaulQ field</th>
            </tr>
          </thead>
          <tbody>
            {upload.headers.map((header) => (
              <tr key={header}>
                <td className="align-middle font-medium">
                  {header}
                  {lowConfidence.has(header) && (
                    <span className="ml-2">
                      <Pill tone="warn">check this</Pill>
                    </span>
                  )}
                </td>
                <td className="align-middle">
                  <span className="num text-sm text-slate">
                    {upload.sampleRows
                      .map((row) => row[header])
                      .filter((v) => v && v.trim() !== '')
                      .slice(0, 3)
                      .join('  ·  ') || <span className="text-mute">empty</span>}
                  </span>
                </td>
                <td className="align-middle">
                  <select
                    className="hq-input"
                    value={mapping[header] ?? ''}
                    onChange={(e) =>
                      setMapping({ ...mapping, [header]: e.target.value || null })
                    }
                  >
                    {FIELDS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6">
        <button
          className="hq-btn hq-btn-brand"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending ? 'Checking every row…' : 'Check the file'}
        </button>
      </div>

      <ErrorNote error={confirm.error} />
    </Card>
  );
}

function ReviewStep({
  batch,
  invalidRows,
  onCommitted,
}: {
  batch: ImportBatch;
  invalidRows: ImportRow[];
  onCommitted: (committed: number, skipped: number) => void;
}) {
  const queryClient = useQueryClient();
  const commit = useMutation({
    mutationFn: () =>
      request<{ committed: number; skipped: number }>(
        `/v1/imports/${batch.id}/commit`,
        { method: 'POST' },
      ),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries();
      onCommitted(res.committed, res.skipped);
    },
  });

  return (
    <Card title="What HaulQ found">
      <div className="mb-6 flex flex-wrap gap-8">
        <div>
          <span className="field-label text-mute">Rows read</span>
          <p className="mt-1 text-2xl">
            <Num value={batch.totalRows} />
          </p>
        </div>
        <div>
          <span className="field-label text-mute">Ready to import</span>
          <p className="mt-1 text-2xl text-ok">
            <Num value={batch.validRows} />
          </p>
        </div>
        <div>
          <span className="field-label text-mute">Cannot be read</span>
          <p className={`mt-1 text-2xl ${batch.invalidRows > 0 ? 'text-warn' : ''}`}>
            <Num value={batch.invalidRows} />
          </p>
        </div>
      </div>

      {invalidRows.length > 0 && (
        <>
          <h3 className="mb-2 text-base">Rows that will be skipped</h3>
          <p className="mb-3 max-w-prose text-sm text-slate">
            Fix these in your file and upload again, or import the rest now and
            add them by hand later.
          </p>
          <div className="overflow-x-auto">
            {/* A load grid has more columns than a phone has width. Scroll it
                inside its own box rather than letting it widen the page. */}
            <table className="hq-table mb-6">
              <thead>
                <tr>
                  <th className="field-label">Row</th>
                  <th className="field-label">Problem</th>
                </tr>
              </thead>
              <tbody>
                {invalidRows.slice(0, 20).map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="num align-top">{row.rowNumber}</td>
                    <td>
                      {row.errors
                        .filter((e) => e.severity === 'error')
                        .map((e, n) => (
                          <span key={n} className="block text-sm text-bad">
                            {e.message}
                          </span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <button
        className="hq-btn hq-btn-brand"
        disabled={commit.isPending || batch.validRows === 0}
        onClick={() => commit.mutate()}
      >
        {commit.isPending
          ? 'Importing…'
          : `Import ${batch.validRows} load${batch.validRows === 1 ? '' : 's'}`}
      </button>

      <ErrorNote error={commit.error} />
    </Card>
  );
}

/**
 * Costs as stated, against costs as they actually were.
 *
 * The comparison is the whole point of Phase 0's exit gate. A carrier whose
 * stated cost is $1.35/mi and whose imported history shows $1.28/mi in revenue
 * is running at a loss on their own numbers, and they should learn that here
 * rather than after HaulQ has spent a month recommending loads on those figures.
 */
function Reconcile() {
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ['history-summary'],
    queryFn: () => request<HistorySummary>('/v1/imports/history-summary'),
  });
  const facts = useQuery({
    queryKey: ['operating-facts'],
    queryFn: () => request<OperatingFactsResponse>('/v1/org/operating-facts'),
  });

  const reconcile = useMutation({
    mutationFn: () => request<{ reconciled: boolean }>('/v1/imports/reconcile', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  if (!summary.data || !facts.data) return null;
  if (summary.data.loadCount === 0) return null;

  const revenuePerMile = summary.data.revenuePerMileCents;
  const costPerMile = facts.data.facts['costPerMileCents'];
  const margin =
    revenuePerMile !== null && costPerMile !== undefined
      ? revenuePerMile - costPerMile
      : null;

  return (
    <Card
      title="Your costs against your actual loads"
      action={
        facts.data.reconciledAt ? <Pill tone="ok">Verified</Pill> : <Pill tone="warn">Unverified</Pill>
      }
    >
      <dl className="mb-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <div>
          <dt className="field-label text-mute">Loads imported</dt>
          <dd className="mt-1 text-2xl">
            <Num value={summary.data.loadCount} />
          </dd>
        </div>
        <div>
          <dt className="field-label text-mute">Days covered</dt>
          <dd className="mt-1 text-2xl">
            <Num value={summary.data.periodDays} />
          </dd>
        </div>
        <div>
          <dt className="field-label text-mute">You earned / mile</dt>
          <dd className="mt-1 text-2xl">
            {revenuePerMile !== null ? <Money cents={revenuePerMile} /> : '—'}
          </dd>
        </div>
        <div>
          <dt className="field-label text-mute">You said it costs</dt>
          <dd className="mt-1 text-2xl">
            {costPerMile !== undefined ? <Money cents={costPerMile} /> : '—'}
          </dd>
        </div>
      </dl>

      {margin !== null && (
        <p
          className={`mb-6 max-w-prose border-l-2 px-3 py-2 text-sm ${
            margin > 0 ? 'border-ok bg-ok-50 text-ok' : 'border-bad bg-bad-50 text-bad'
          }`}
        >
          {margin > 0 ? (
            <>
              Across {summary.data.loadCount} loads you cleared{' '}
              <Money cents={margin} /> per mile above your stated running cost,
              before fixed costs.
            </>
          ) : (
            <>
              Across {summary.data.loadCount} loads you earned{' '}
              <Money cents={Math.abs(margin)} /> per mile <strong>less</strong>{' '}
              than your stated running cost. Either the cost figure is too high
              or these lanes are not paying.
            </>
          )}
        </p>
      )}

      {!facts.data.reconciledAt && (
        <>
          <button
            className="hq-btn hq-btn-primary"
            disabled={reconcile.isPending || costPerMile === undefined}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? 'Confirming…' : 'These figures look right'}
          </button>
          {costPerMile === undefined && (
            <p className="mt-2 text-sm text-warn">
              Enter your cost per mile on the Carrier screen first — there is
              nothing to compare against yet.
            </p>
          )}
          <ErrorNote error={reconcile.error} />
        </>
      )}
    </Card>
  );
}

export function ImportScreen() {
  const [stage, setStage] = useState<Stage>({ name: 'upload' });

  const batches = useQuery({
    queryKey: ['imports'],
    queryFn: () => request<{ items: ImportBatch[] }>('/v1/imports'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Load history</h1>
          <p className="mt-1 max-w-prose text-slate">
            Importing what you have already run is how HaulQ learns what your
            business actually costs, instead of guessing from industry averages.
          </p>
        </div>
        {stage.name !== 'upload' && (
          <button
            className="hq-btn hq-btn-ghost"
            onClick={() => setStage({ name: 'upload' })}
          >
            Start over
          </button>
        )}
      </div>

      {stage.name === 'upload' && (
        <UploadStep onUploaded={(upload) => setStage({ name: 'mapping', upload })} />
      )}

      {stage.name === 'mapping' && (
        <MappingStep
          upload={stage.upload}
          onMapped={(batch, invalidRows) =>
            setStage({ name: 'review', batch, invalidRows })
          }
        />
      )}

      {stage.name === 'review' && (
        <ReviewStep
          batch={stage.batch}
          invalidRows={stage.invalidRows}
          onCommitted={(committed, skipped) =>
            setStage({ name: 'done', committed, skipped })
          }
        />
      )}

      {stage.name === 'done' && (
        <Card title="Imported">
          <p className="text-lg">
            <Num value={stage.committed} /> loads are now in HaulQ
            {stage.skipped > 0 && (
              <>
                {' '}
                — <Num value={stage.skipped} /> rows were skipped because they
                could not be read
              </>
            )}
            .
          </p>
          <button
            className="hq-btn hq-btn-ghost mt-4"
            onClick={() => setStage({ name: 'upload' })}
          >
            Import another file
          </button>
        </Card>
      )}

      <Reconcile />

      <Card title="Previous imports">
        {batches.data?.items.length === 0 && <Empty>Nothing imported yet.</Empty>}
        {batches.data && batches.data.items.length > 0 && (
          <div className="overflow-x-auto">
            {/* A load grid has more columns than a phone has width. Scroll it
                inside its own box rather than letting it widen the page. */}
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">File</th>
                  <th className="field-label">Status</th>
                  <th className="field-label">Imported</th>
                  <th className="field-label">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {batches.data.items.map((b) => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.filename}</td>
                    <td>
                      <Pill tone={b.status === 'committed' ? 'ok' : 'neutral'}>
                        {b.status}
                      </Pill>
                    </td>
                    <td className="num">{b.committedRows}</td>
                    <td className="num">{b.invalidRows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
