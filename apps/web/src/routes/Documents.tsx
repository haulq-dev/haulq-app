/**
 * Documents.
 *
 * Three views of the same table, in the order a carrier meets them:
 *
 * **The inbox** is documents no load claims yet. That is the pile that has to be
 * worked, and it is the default because a rate confirmation sitting unattached
 * is the one state where paperwork silently stops moving.
 *
 * **The detail panel** shows the file itself. A carrier checking whether HaulQ
 * read something correctly wants to look at the page, not at a JSON dump of what
 * a model thought was on it.
 *
 * **The disagreement view** is the one that matters. Extraction says the model
 * read $2,400 off the PDF; validation says whether that is what the broker
 * agreed to. Until the extraction and validation passes land, `validation` is
 * null on every row and this view says so honestly rather than showing a green
 * tick it has not earned.
 *
 * The verdict here comes from `summarizeValidation` in `@haulq/contracts` — the
 * same function the repository used to decide the stored status. The screen and
 * the database cannot disagree about what "rejected" means, because there is
 * only one implementation of the rule.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  documentKindLabel,
  summarizeValidation,
  type ValidationFinding,
} from '@haulq/contracts';
import { request, requestBlob } from '../lib/api.ts';
import { useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Pill } from '../components/ui.tsx';

interface DocumentRow {
  id: string;
  kind: string;
  kindConfidence: number | null;
  status: string;
  source: string;
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  pageCount: number | null;
  sha256: string;
  loadId: string | null;
  receivedFrom: string | null;
  receivedAt: string;
  extracted: Record<string, unknown> | null;
  extractedAt: string | null;
  extractorVersion: string | null;
  validation: ValidationFinding[] | null;
  validatedAt: string | null;
  rejectionReason: string | null;
}

interface LoadOption {
  id: string;
  reference: number;
  brokerName: string | null;
  stops: Array<{ type: string; city: string; state: string }>;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  validated: 'ok',
  rejected: 'warn',
  quarantined: 'warn',
};

/** Accepted by the API's sniffer. Advisory only — the bytes are what decide. */
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.tif,.tiff,.heic,application/pdf,image/*';

function fileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

function loadLabel(load: LoadOption): string {
  const pickup = load.stops.find((s) => s.type === 'pickup');
  const delivery = [...load.stops].reverse().find((s) => s.type === 'delivery');
  const lane =
    pickup && delivery
      ? ` · ${pickup.city}, ${pickup.state} → ${delivery.city}, ${delivery.state}`
      : '';
  return `Load ${load.reference}${load.brokerName ? ` · ${load.brokerName}` : ''}${lane}`;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Reports what happened to each file, including the ones already held.
 *
 * A silent no-op on a duplicate is the wrong answer: someone who re-sends a
 * rate confirmation and sees nothing change assumes the upload failed and does
 * it again. Deduping is a feature, so it gets said out loud.
 */
function Dropzone() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const send = async (files: FileList) => {
    setBusy(true);
    setError(null);
    setNote(null);

    let added = 0;
    let already = 0;

    try {
      for (const file of Array.from(files)) {
        const res = await request<{ deduped: boolean }>(
          `/v1/documents?filename=${encodeURIComponent(file.name)}`,
          {
            raw: {
              body: file,
              // The API sniffs the bytes regardless. Sending the browser's
              // guess only has to get the request past the content type parser.
              contentType: file.type || 'application/octet-stream',
            },
          },
        );
        if (res.deduped) already += 1;
        else added += 1;
      }

      setNote(
        [
          added ? `${added} added` : null,
          already ? `${already} you already had` : null,
        ]
          .filter(Boolean)
          .join(', '),
      );
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add paperwork">
      <p className="mb-5 max-w-prose text-sm text-slate">
        Rate confirmations, bills of lading, PODs, invoices. PDFs and photos both
        work — a picture of a signed BOL taken at the dock is fine. Sending the
        same file twice is harmless; HaulQ keeps one copy.
      </p>

      <label className="block cursor-pointer border-2 border-dashed border-line bg-wash p-10 text-center hover:border-brand">
        <input
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) void send(files);
            e.target.value = '';
          }}
        />
        <span className="block text-lg">
          {busy ? 'Uploading…' : 'Choose files'}
        </span>
        <span className="mt-1 block text-xs text-mute">
          PDF, JPEG, PNG, TIFF or HEIC, up to 25 MB each
        </span>
      </label>

      {note && <p className="mt-3 text-sm text-ok">{note}.</p>}
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Attaching
// ---------------------------------------------------------------------------

function AttachControl({ document }: { document: DocumentRow }) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState('');

  const loads = useQuery({
    queryKey: ['loads'],
    queryFn: () => request<{ items: LoadOption[] }>('/v1/loads?limit=100'),
  });

  const attach = useMutation({
    mutationFn: (loadId: string) =>
      request(`/v1/documents/${document.id}/attach`, {
        method: 'POST',
        body: { loadId },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });

  const options = loads.data?.items ?? [];

  if (loads.isSuccess && options.length === 0) {
    return (
      <span className="text-xs text-mute">
        No loads yet — create one before attaching this.
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Attach to load"
        className="border border-line bg-white px-2 py-1 text-sm"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">Attach to…</option>
        {options.map((load) => (
          <option key={load.id} value={load.id}>
            {loadLabel(load)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="border border-line px-3 py-1 text-sm disabled:opacity-40"
        disabled={!choice || attach.isPending}
        onClick={() => attach.mutate(choice)}
      >
        {attach.isPending ? 'Attaching…' : 'Attach'}
      </button>
      <ErrorNote error={attach.error} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

/**
 * Preview the bytes.
 *
 * Fetched through the API client rather than pointed at with a `src`, because
 * the request needs auth headers. The object URL is revoked when the panel
 * closes — a few unrevoked PDFs is a real leak on a dispatcher's tab that stays
 * open all day.
 */
function Preview({ document }: { document: DocumentRow }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);

    requestBlob(`/v1/documents/${document.id}/content`)
      .then((blob) => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        current.current = next;
        setUrl(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });

    return () => {
      cancelled = true;
      if (current.current) {
        URL.revokeObjectURL(current.current);
        current.current = null;
      }
    };
  }, [document.id]);

  if (error) return <ErrorNote error={error} />;
  if (!url) return <Empty>Loading the file…</Empty>;

  const isImage = (document.contentType ?? '').startsWith('image/');

  return isImage ? (
    <img
      src={url}
      alt={document.filename ?? 'Document'}
      className="max-h-[36rem] w-full border border-line object-contain"
    />
  ) : (
    <iframe
      src={url}
      title={document.filename ?? 'Document'}
      className="h-[36rem] w-full border border-line"
    />
  );
}

// ---------------------------------------------------------------------------
// The disagreement view
// ---------------------------------------------------------------------------

function Disagreements({ document }: { document: DocumentRow }) {
  if (!document.validation) {
    return (
      <Empty>
        {document.extractedAt
          ? 'Read, but not yet checked against a load.'
          : 'Not read yet. HaulQ checks a document against its load once it has been extracted.'}
      </Empty>
    );
  }

  const verdict = summarizeValidation(document.validation);

  return (
    <div>
      <p className="mb-3 text-sm">
        {verdict.outcome === 'validated' ? (
          <span className="text-ok">
            Everything on this document agrees with the load.
          </span>
        ) : (
          <span className="text-bad">{verdict.reason}</span>
        )}
      </p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="field-label py-2 text-mute">Field</th>
            <th className="field-label py-2 text-mute">Document says</th>
            <th className="field-label py-2 text-mute">Load says</th>
          </tr>
        </thead>
        <tbody>
          {document.validation.map((f) => (
            <tr key={f.field} className="border-b border-line last:border-0">
              <td className="py-2">
                {f.field}
                {!f.agrees && (
                  <span className="ml-2">
                    <Pill tone={f.severity === 'error' ? 'warn' : 'neutral'}>
                      {f.severity}
                    </Pill>
                  </span>
                )}
              </td>
              {/* Colour is never the only signal — the severity pill above
                  carries the same information as a word. */}
              <td className={`num py-2 ${f.agrees ? '' : 'text-bad'}`}>
                {f.documentValue ?? '—'}
              </td>
              <td className="num py-2">{f.loadValue ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

function Detail({ document }: { document: DocumentRow }) {
  return (
    <div className="border-t border-line bg-wash px-5 py-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="field-label mb-2 text-mute">The document</h3>
          <Preview document={document} />
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate">
            <dt className="text-mute">Received</dt>
            <dd>{when(document.receivedAt)}</dd>
            <dt className="text-mute">Source</dt>
            <dd>{document.source.replace(/_/g, ' ')}</dd>
            {document.receivedFrom && (
              <>
                <dt className="text-mute">From</dt>
                <dd>{document.receivedFrom}</dd>
              </>
            )}
            {document.extractorVersion && (
              <>
                <dt className="text-mute">Read by</dt>
                <dd className="num">{document.extractorVersion}</dd>
              </>
            )}
            <dt className="text-mute">Digest</dt>
            <dd className="num" title={document.sha256}>
              {document.sha256.slice(0, 12)}…
            </dd>
          </dl>
        </div>

        <div>
          <h3 className="field-label mb-2 text-mute">Against the load</h3>
          <Disagreements document={document} />
        </div>
      </div>
    </div>
  );
}

export function DocumentsScreen() {
  const session = useSession();
  const [view, setView] = useState<'inbox' | 'all'>('inbox');
  const [open, setOpen] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['documents', view],
    queryFn: () =>
      request<{ items: DocumentRow[] }>(
        view === 'inbox' ? '/v1/documents?unattached=true' : '/v1/documents',
      ),
    enabled: Boolean(session?.orgId),
  });

  const counts = useQuery({
    queryKey: ['documents', 'counts'],
    queryFn: () => request<{ counts: Record<string, number> }>('/v1/documents/counts'),
    enabled: Boolean(session?.orgId),
  });

  const items = query.data?.items ?? [];
  const rejected = counts.data?.counts['rejected'] ?? 0;

  return (
    <div className="space-y-6">
      <Dropzone />

      {rejected > 0 && (
        <p className="border-l-2 border-bad bg-bad-50 px-3 py-2 text-sm text-bad">
          {rejected === 1
            ? '1 document does not match its load.'
            : `${rejected} documents do not match their loads.`}{' '}
          Those are the ones worth opening first.
        </p>
      )}

      <Card
        title={view === 'inbox' ? 'Needs a load' : 'All documents'}
        action={
          <span className="flex gap-1">
            {(['inbox', 'all'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={`field-label px-3 py-1 ${
                  view === v ? 'border-b-2 border-brand text-ink' : 'text-mute'
                }`}
              >
                {v === 'inbox' ? 'Needs a load' : 'All'}
              </button>
            ))}
          </span>
        }
      >
        <ErrorNote error={query.error} />

        {query.isLoading && <Empty>Loading…</Empty>}

        {query.isSuccess && items.length === 0 && (
          <Empty>
            {view === 'inbox'
              ? 'Nothing waiting. Every document you have is on a load.'
              : 'No documents yet. Add one above, and email intake will fill this in once it is switched on.'}
          </Empty>
        )}

        {items.length > 0 && (
          <ul className="divide-y divide-line">
            {items.map((doc) => (
              <li key={doc.id}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setOpen(open === doc.id ? null : doc.id)}
                    aria-expanded={open === doc.id}
                  >
                    <span className="block truncate">
                      {doc.filename ?? 'Untitled'}
                    </span>
                    <span className="block text-xs text-mute">
                      {documentKindLabel(doc.kind)} · {when(doc.receivedAt)}
                      {doc.byteSize ? ` · ${fileSize(doc.byteSize)}` : ''}
                    </span>
                  </button>

                  <Pill tone={STATUS_TONE[doc.status] ?? 'neutral'}>{doc.status}</Pill>

                  {doc.loadId === null && <AttachControl document={doc} />}
                </div>

                {open === doc.id && <Detail document={doc} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
