import type { DocumentRow } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn(), requestBlob: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' })) };
});
vi.mock('../../lib/share.ts', () => ({ shareOrCopy: vi.fn().mockResolvedValue('copied') }));
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ documentId: 'D1' }),
}));

import { request } from '../../lib/api.ts';
import { shareOrCopy } from '../../lib/share.ts';
import { aLoad, answerRequests, renderScreen } from '../../test-utils.tsx';
import { Paperwork } from '../../components/Paperwork.tsx';
import { DocumentScreen } from './DocumentScreen.tsx';
import { DocumentsScreen } from './DocumentsScreen.tsx';

// jsdom has no object URLs.
URL.createObjectURL = vi.fn(() => 'blob:x');
URL.revokeObjectURL = vi.fn();

function aDoc(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'D1', kind: 'rate_confirmation', kindConfidence: 0.95, status: 'rejected', source: 'upload',
    filename: 'ratecon.jpg', contentType: 'image/jpeg', byteSize: 250_000, pageCount: 1, sha256: 'abc',
    loadId: 'L1', receivedFrom: null, receivedAt: '2026-09-23T15:00:00Z', extracted: { rateAmount: { raw: '$2,400.00' }, brokerLoadNumber: { raw: '88213' } },
    extractedAt: '2026-09-23T15:01:00Z', extractorVersion: 'rules-1', validatedAt: '2026-09-23T15:01:00Z',
    rejectionReason: null,
    validation: [
      { field: 'rateAmount', documentValue: '$2,400.00', loadValue: '$2,200.00', agrees: false, severity: 'error' },
      { field: 'brokerLoadNumber', documentValue: '88213', loadValue: '88213', agrees: true, severity: 'info' },
    ],
    ...overrides,
  };
}

describe('DocumentsScreen', () => {
  beforeEach(() => {
    (request as Mock).mockReset();
  });

  it('opens on the inbox, warns about rejected paperwork, and shares the intake address', async () => {
    answerRequests({
      '/v1/documents?unattached=true': { items: [aDoc({ loadId: null, status: 'received' })], nextCursor: null },
      '/v1/documents/counts': { counts: { rejected: 2 } },
      '/v1/org/profile': { slug: 'acme', customDocsEmail: null },
    });
    renderScreen(<DocumentsScreen />);

    expect(await screen.findByText('Rate confirmation')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Needs a load' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/2 documents do not match their loads/)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Share address' }));
    expect(shareOrCopy).toHaveBeenCalledWith(expect.objectContaining({ text: 'docs+acme@docs.haulq.ai' }));
  });
});

describe('DocumentScreen', () => {
  beforeEach(() => {
    (request as Mock).mockReset();
  });

  it('shows where the document disagrees with its load, in words as well as colour', async () => {
    answerRequests({ '/v1/documents/D1': { document: aDoc() }, '/v1/loads': { items: [aLoad()] } });
    renderScreen(<DocumentScreen />);

    expect(await screen.findAllByText('Document says')).toHaveLength(2);
    expect(screen.getByText('$2,200.00')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('attaches to a chosen load', async () => {
    const attached: unknown[] = [];
    answerRequests({
      '/v1/documents/D1': { document: aDoc({ loadId: null, validation: null }) },
      '/v1/documents/D1/attach': (o: { body: unknown }) => attached.push(o.body),
      '/v1/loads': { items: [aLoad()] },
    });
    renderScreen(<DocumentScreen />);

    const select = await screen.findByLabelText('Attach to a load');
    await waitFor(() => expect(screen.getByRole('option', { name: /Load 1042/ })).toBeInTheDocument());
    await userEvent.selectOptions(select, 'L1');
    await userEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(attached).toEqual([{ loadId: 'L1' }]));
  });

  it('sends only the fields that were actually changed', async () => {
    const saved: unknown[] = [];
    answerRequests({
      '/v1/documents/D1': { document: aDoc() },
      '/v1/documents/D1/manual-fields': (o: { body: unknown }) => saved.push(o.body),
      '/v1/loads': { items: [aLoad()] },
    });
    renderScreen(<DocumentScreen />);

    // Every expected field was read, so the form starts closed.
    await userEvent.click(await screen.findByRole('button', { name: 'Correct a field' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const rate = await screen.findByDisplayValue('$2,400.00');
    await userEvent.clear(rate);
    await userEvent.type(rate, '2200');
    await userEvent.click(save);
    await waitFor(() => expect(saved).toEqual([{ fields: { rateAmount: '2200' } }]));
  });
});

describe('Paperwork', () => {
  beforeEach(() => {
    (request as Mock).mockReset();
  });

  it('lets a driver say what the page is, and sends it attached to their load', async () => {
    const uploads: string[] = [];
    (request as Mock).mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/documents?filename=')) {
        uploads.push(path);
        return { deduped: false };
      }
      return { items: [aDoc({ kind: 'pod', status: 'received' })], nextCursor: null };
    });
    renderScreen(<Paperwork loadId="L1" forDriver />);

    expect(await screen.findByText('POD', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'BOL' }));
    await userEvent.upload(screen.getByLabelText('Take a photo'), new File(['x'], 'bol.png', { type: 'image/png' }));

    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toContain('loadId=L1');
    expect(uploads[0]).toContain('kind=bol');
    expect(await screen.findByText('1 added.')).toBeInTheDocument();
  });

  it('leaves the kind to the classifier for "Something else"', async () => {
    const uploads: string[] = [];
    (request as Mock).mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/documents?filename=')) {
        uploads.push(path);
        return { deduped: false };
      }
      return { items: [], nextCursor: null };
    });
    renderScreen(<Paperwork loadId="L1" forDriver />);

    await userEvent.click(await screen.findByRole('radio', { name: 'Something else' }));
    await userEvent.upload(screen.getByLabelText('Take a photo'), new File(['x'], 'x.png', { type: 'image/png' }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).not.toContain('kind=');
  });
});
