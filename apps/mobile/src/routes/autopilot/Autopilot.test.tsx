import type { OutboundEvidence, OutboundMessage, OutboundSettingsResponse } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'u', orgId: 'o', orgName: 'Acme Freight', role: 'owner' as string } };
const params = { messageId: '00000000-0000-4000-8000-000000000001' };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn(), requestBlob: vi.fn(async () => new Blob(['%PDF-'], { type: 'application/pdf' })) };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params: p, ...rest }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={p ? to.replace(/\$(\w+)/g, (_, k: string) => p[k] ?? '') : to} {...rest}>
      {children}
    </a>
  ),
  useParams: () => params,
}));

import { request, requestBlob } from '../../lib/api.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { AutopilotScreen } from './AutopilotScreen.tsx';
import { MessageScreen } from './MessageScreen.tsx';

const ID = '00000000-0000-4000-8000-000000000001';

const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: ID,
  actionType: 'payment_reminder',
  mode: 'draft',
  status: 'pending_approval',
  holdReason: null,
  toAddresses: ['ap@prairie.example.com'],
  subject: 'Payment reminder — 2 invoices',
  body: 'Hello,\n\nThis is a friendly reminder.',
  attachments: [],
  relatedType: 'broker',
  relatedId: '00000000-0000-4000-8000-0000000000aa',
  verdict: null,
  verdictNote: null,
  error: null,
  sentAt: null,
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  ...over,
});

const settings = (over: Partial<OutboundSettingsResponse> = {}): OutboundSettingsResponse => ({
  sendingEnabled: true,
  autopilotRunning: true,
  modes: { test: 'shadow', pod_chase: 'shadow', invoice_delivery: 'draft', payment_reminder: 'draft', broker_message: 'shadow', detention_claim: 'shadow' },
  configured: { invoice_delivery: 'draft', payment_reminder: 'draft' },
  actions: [
    { type: 'invoice_delivery', label: 'Send an invoice', maxMode: 'draft', available: true },
    { type: 'payment_reminder', label: 'Payment reminder', maxMode: 'act', available: true },
  ],
  ...over,
});

const evidence = (over: Partial<OutboundEvidence> = {}): OutboundEvidence => ({
  previewRight: 0,
  previewWrong: 0,
  previewUnmarked: 0,
  recentPreviewWrong: 0,
  approved: 0,
  rejected: 0,
  recentRejected: 0,
  ...over,
});

interface World {
  messages: OutboundMessage[];
  settings: OutboundSettingsResponse;
  evidence: Record<string, OutboundEvidence>;
  mailbox: { connected: boolean; status: string; provider: string | null; connectedAt: string | null };
}

function world(over: Partial<World> = {}) {
  const w: World = {
    messages: [],
    settings: settings(),
    evidence: {},
    mailbox: { connected: true, status: 'connected', provider: 'GOOGLE', connectedAt: null },
    ...over,
  };
  answerRequests({
    '/v1/outbound/settings': w.settings,
    '/v1/outbound/messages': { messages: w.messages },
    '/v1/outbound/evidence': { actions: w.evidence },
    '/v1/mailbox': w.mailbox,
    // Any write answers ok; the tests read what was sent from the mock's calls.
    '/v1/outbound/messages/': (o: unknown) => ((o as { method?: string } | undefined)?.method ? { ok: true } : { messages: w.messages }),
  });
}

const sent = (method: string, path: string) =>
  (request as Mock).mock.calls.some(([p, o]) => p === path && (o as { method?: string } | undefined)?.method === method);

beforeEach(() => {
  (request as Mock).mockReset();
  (requestBlob as Mock).mockClear();
  session.current = { ...session.current, role: 'owner' };
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('AutopilotScreen — the inbox', () => {
  it('opens on what is waiting, and approves nothing from the list', async () => {
    world({ messages: [message()] });
    renderScreen(<AutopilotScreen />);

    expect(await screen.findByText('Payment reminder — 2 invoices')).toBeInTheDocument();
    expect(screen.getByText('To ap@prairie.example.com')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Needs your OK/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Payment reminder — 2 invoices/ })).toHaveAttribute('href', `/autopilot/${ID}`);
  });

  it('opens on the previews when nothing waits, which is how every new carrier starts', async () => {
    world({ messages: [message({ status: 'shadow', subject: 'A preview' })] });
    renderScreen(<AutopilotScreen />);

    expect(await screen.findByText('A preview')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Previews/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Not looked at')).toBeInTheDocument();
    expect(screen.getByText(/tell it whether it is what you would have wanted/)).toBeInTheDocument();
  });

  it('puts sent and failed messages together in History, newest first', async () => {
    world({
      messages: [
        message({ id: 'a1', status: 'failed', error: 'x', subject: 'Failed one', createdAt: new Date(Date.now() - 1 * 3_600_000).toISOString() }),
        message({ id: 'a2', status: 'sent', subject: 'Sent one', createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }),
        message({ id: 'a3', status: 'rejected', subject: 'Rejected one', createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
      ],
    });
    renderScreen(<AutopilotScreen />);
    await userEvent.click(await screen.findByRole('tab', { name: /History/ }));

    const subjects = screen.getAllByRole('link').map((a) => a.textContent ?? '');
    expect(subjects[0]).toMatch(/Failed one/);
    expect(subjects[1]).toMatch(/Rejected one/);
    expect(subjects[2]).toMatch(/Sent one/);
  });

  it('says so when nothing is there yet, in the carrier’s words', async () => {
    world({});
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText(/Nothing is waiting for you/)).toBeInTheDocument();
  });

  it('never shows the server’s words, or anything about plans and prices', async () => {
    world({ messages: [message()] });
    renderScreen(<AutopilotScreen />);
    await screen.findByText('Payment reminder — 2 invoices');
    for (const name of [/Previews/, /History/]) await userEvent.click(screen.getByRole('tab', { name }));
    expect(document.body.textContent ?? '').not.toMatch(/shadow|\bdraft\b|upgrade|subscribe|pricing|billing|\bplan\b/i);
  });

  it('is not for a driver', async () => {
    session.current = { ...session.current, role: 'driver' };
    world({});
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText(/for the people who run the business side/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('AutopilotScreen — stopping it', () => {
  it('lets the owner stop sending, after asking', async () => {
    world({});
    renderScreen(<AutopilotScreen />);
    window.confirm = vi.fn(() => true);

    await userEvent.click(await screen.findByRole('button', { name: 'Stop sending' }));

    await waitFor(() => expect(sent('PUT', '/v1/outbound/settings')).toBe(true));
    expect((request as Mock).mock.calls.find(([, o]) => (o as { method?: string })?.method === 'PUT')![1]).toMatchObject({ body: { sendingEnabled: false } });
  });

  it('does nothing if the owner backs out', async () => {
    world({});
    renderScreen(<AutopilotScreen />);
    window.confirm = vi.fn(() => false);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop sending' }));
    expect(sent('PUT', '/v1/outbound/settings')).toBe(false);
  });

  it('shows OFF loudly, and sends the owner to the web to turn it back on', async () => {
    world({ settings: settings({ sendingEnabled: false }) });
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText('Sending from your mailbox is OFF')).toBeInTheDocument();
    expect(screen.getByText(/Turn it back on from HaulQ on the web/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop sending' })).not.toBeInTheDocument();
  });

  it('gives a dispatcher the status but not the switch', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    world({});
    renderScreen(<AutopilotScreen />);
    await screen.findByRole('tab', { name: /Needs your OK/ });
    expect(screen.queryByRole('button', { name: 'Stop sending' })).not.toBeInTheDocument();
  });
});

describe('AutopilotScreen — setup lives on the web', () => {
  it('tells the owner what is left, without a link to follow', async () => {
    world({ mailbox: { connected: false, status: 'not_connected', provider: null, connectedAt: null } });
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText(/Connect your mailbox from HaulQ on the web/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /connect|web/i })).not.toBeInTheDocument();
  });

  it('says when Autopilot is not running on the server at all', async () => {
    world({ settings: settings({ autopilotRunning: false }) });
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText(/not switched on for this HaulQ server yet/)).toBeInTheDocument();
  });

  it('asks an owner with nothing chosen to choose', async () => {
    world({ settings: settings({ configured: {} }) });
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText(/Choose what Autopilot should do from HaulQ on the web/)).toBeInTheDocument();
  });
});

describe('AutopilotScreen — ready to move up', () => {
  const ready = () =>
    world({
      messages: [message({ status: 'shadow' })],
      settings: settings({ configured: { payment_reminder: 'shadow', invoice_delivery: 'shadow' } }),
      evidence: { payment_reminder: evidence({ previewRight: 6 }) },
    });

  it('offers it on the previews, with the count, and applies nothing until the owner taps', async () => {
    ready();
    renderScreen(<AutopilotScreen />);

    expect(await screen.findByText(/Ready to move up\? Payment reminders/)).toBeInTheDocument();
    expect(screen.getByText(/6 of 6 previews marked right/)).toBeInTheDocument();
    expect(sent('PUT', '/v1/outbound/settings')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /Switch to “Ask me first”/ }));
    await waitFor(() => expect(sent('PUT', '/v1/outbound/settings')).toBe(true));
    expect((request as Mock).mock.calls.find(([, o]) => (o as { method?: string })?.method === 'PUT')![1]).toMatchObject({
      body: { modes: { payment_reminder: 'draft' } },
    });
  });

  it('leaves the decision to the owner', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    ready();
    renderScreen(<AutopilotScreen />);
    expect(await screen.findByText(/Ready to move up\?/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
  });
});

describe('MessageScreen — a message waiting for an OK', () => {
  it('shows all of it, and approves only from here', async () => {
    world({ messages: [message()] });
    renderScreen(<MessageScreen />);

    expect(await screen.findByText(/This is a friendly reminder/)).toBeInTheDocument();
    expect(screen.getByText('To ap@prairie.example.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }));

    await waitFor(() => expect(sent('POST', `/v1/outbound/messages/${ID}/approve`)).toBe(true));
  });

  it('rejects without sending', async () => {
    world({ messages: [message()] });
    renderScreen(<MessageScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(sent('POST', `/v1/outbound/messages/${ID}/reject`)).toBe(true));
    expect(sent('POST', `/v1/outbound/messages/${ID}/approve`)).toBe(false);
  });

  it('cannot be approved while sending is switched off, and says so', async () => {
    world({ messages: [message()], settings: settings({ sendingEnabled: false }) });
    renderScreen(<MessageScreen />);
    expect(await screen.findByRole('button', { name: 'Approve and send' })).toBeDisabled();
    expect(screen.getByText(/switched off, so this cannot be approved/)).toBeInTheDocument();
  });

  it('opens the invoice PDF from the attachment, through the same viewer as any document', async () => {
    const attachments = [{ kind: 'invoice' as const, refId: '00000000-0000-4000-8000-0000000000bb', filename: 'Invoice-1042.pdf', contentType: 'application/pdf', byteSize: null }];
    world({ messages: [message({ actionType: 'invoice_delivery', attachments })] });
    renderScreen(<MessageScreen />);

    await userEvent.click(await screen.findByRole('button', { name: /Invoice-1042\.pdf/ }));

    await waitFor(() => expect(requestBlob).toHaveBeenCalledWith('/v1/invoices/00000000-0000-4000-8000-0000000000bb/pdf'));
  });

  it('opens a stored document from its own path', async () => {
    const attachments = [{ kind: 'document' as const, refId: '00000000-0000-4000-8000-0000000000cc', filename: 'POD.pdf', contentType: 'application/pdf', byteSize: 2048 }];
    world({ messages: [message({ attachments })] });
    renderScreen(<MessageScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /POD\.pdf/ }));
    await waitFor(() => expect(requestBlob).toHaveBeenCalledWith('/v1/documents/00000000-0000-4000-8000-0000000000cc/content'));
  });

  it('links to the load it is about', async () => {
    world({ messages: [message({ relatedType: 'load', relatedId: '00000000-0000-4000-8000-0000000000dd' })] });
    renderScreen(<MessageScreen />);
    expect(await screen.findByRole('link', { name: /Open the load/ })).toHaveAttribute('href', '/loads/00000000-0000-4000-8000-0000000000dd');
  });
});

describe('MessageScreen — a preview', () => {
  const preview = (over: Partial<OutboundMessage> = {}) => message({ status: 'shadow', mode: 'shadow', ...over });

  it('marks it right in one tap', async () => {
    world({ messages: [preview()] });
    renderScreen(<MessageScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Looks right' }));
    await waitFor(() => expect(sent('POST', `/v1/outbound/messages/${ID}/mark`)).toBe(true));
    expect((request as Mock).mock.calls.find(([p]) => String(p).endsWith('/mark'))![1]).toMatchObject({ body: { verdict: 'right' } });
  });

  it('asks why when it is not right, and the answer is optional', async () => {
    world({ messages: [preview()] });
    renderScreen(<MessageScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Not right' }));
    await userEvent.type(screen.getByLabelText('What was wrong?'), 'The amount is off.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', `/v1/outbound/messages/${ID}/mark`)).toBe(true));
    expect((request as Mock).mock.calls.find(([p]) => String(p).endsWith('/mark'))![1]).toMatchObject({
      body: { verdict: 'wrong', note: 'The amount is off.' },
    });
  });

  it('shows the verdict already given, and why the preview was held', async () => {
    world({ messages: [preview({ verdict: 'wrong', verdictNote: 'Wrong broker.', holdReason: 'sending_disabled' })] });
    renderScreen(<MessageScreen />);
    expect(await screen.findByRole('button', { name: 'Not right' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/You said: Wrong broker\./)).toBeInTheDocument();
    expect(screen.getByText(/Held because sending from your mailbox is switched off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });
});

describe('MessageScreen — after the fact', () => {
  it('reads a sent message with nothing left to do', async () => {
    world({ messages: [message({ status: 'sent', sentAt: new Date().toISOString() })] });
    renderScreen(<MessageScreen />);
    expect(await screen.findByText('Sent just now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve|Reject|Looks right/ })).not.toBeInTheDocument();
  });

  it('says what went wrong with a failed one, and that an old one was withdrawn', async () => {
    world({ messages: [message({ status: 'failed', error: 'A file was missing.' })] });
    const { unmount } = renderScreen(<MessageScreen />);
    expect(await screen.findByText('A file was missing.')).toBeInTheDocument();
    unmount();

    world({ messages: [message({ status: 'expired' })] });
    renderScreen(<MessageScreen />);
    expect(await screen.findByText(/went out of date before anyone approved it/)).toBeInTheDocument();
  });

  it('says so when the message is not there', async () => {
    world({ messages: [] });
    renderScreen(<MessageScreen />);
    expect(await screen.findByText(/no longer here/)).toBeInTheDocument();
  });
});
