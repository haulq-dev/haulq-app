/**
 * A list of documents, each opening its own screen. Used by the Documents
 * tab, and by the paperwork section on a load.
 */

import { documentTitle, DOCUMENT_STATUS_TONE, fileSize, type DocumentRow } from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { Pill } from './ui.tsx';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function DocumentRows({ items, linkable = true }: { items: DocumentRow[]; linkable?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((doc) => {
        const body = (
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate">{documentTitle(doc.kind)}</p>
              <p className="truncate text-xs text-mute">
                {doc.filename ?? 'Untitled'} · {when(doc.receivedAt)}
                {doc.byteSize ? ` · ${fileSize(doc.byteSize)}` : ''}
              </p>
            </div>
            <Pill tone={DOCUMENT_STATUS_TONE[doc.status] ?? 'neutral'}>{doc.status}</Pill>
          </div>
        );
        return (
          <li key={doc.id}>
            {linkable ? (
              <Link to="/documents/$documentId" params={{ documentId: doc.id }} className="block">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
