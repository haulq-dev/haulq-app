/**
 * A load's paperwork: what's on it, and a way to add to it from the phone.
 *
 * Two audiences, one component:
 * - **A driver** at the dock. They pick what the page is (POD, BOL, lumper
 *   receipt, scale ticket) before the camera opens, and it arrives attached
 *   to their load and labelled. This is the reason the app has a camera. The
 *   API lets a driver send paperwork only for their own loads, and read only
 *   their own loads' documents.
 * - **The office**, on the load screen. Same capture with no "what is it?"
 *   step (the classifier decides), and each row opens the document.
 */

import { useDocuments } from '@haulq/client';
import { DocumentCapture } from './DocumentCapture.tsx';
import { DocumentRows } from './DocumentRows.tsx';
import { Card, ErrorNote, LoadMore } from './ui.tsx';

/** What a driver photographs, in order of how often. "Something else" leaves it to the classifier. */
export const DRIVER_KINDS = [
  { kind: 'pod', label: 'POD' },
  { kind: 'bol', label: 'BOL' },
  { kind: 'lumper_receipt', label: 'Lumper receipt' },
  { kind: 'scale_ticket', label: 'Scale ticket' },
  { kind: '', label: 'Something else' },
] as const;

export function Paperwork({ loadId, forDriver }: { loadId: string; forDriver: boolean }) {
  const docs = useDocuments({ loadId });
  const items = docs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card title="Paperwork">
      <div className="space-y-3">
        <DocumentCapture loadId={loadId} {...(forDriver ? { kinds: DRIVER_KINDS } : {})} />
        <ErrorNote error={docs.error} />
        {docs.isSuccess && items.length === 0 && <p className="text-sm text-mute">Nothing on this load yet.</p>}
        {items.length > 0 && <DocumentRows items={items} linkable={!forDriver} />}
        <LoadMore onClick={() => void docs.fetchNextPage()} loading={docs.isFetchingNextPage} hasMore={docs.hasNextPage} />
      </div>
    </Card>
  );
}
