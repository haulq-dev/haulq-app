import { ApiClientProvider, type ApiClient, type OutboundMessage, type OutboundSettingsResponse } from '@haulq/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request, writeSession } from '../lib/api.ts';
import { AutopilotScreen } from './Autopilot.tsx';

// The org list (and so the role) still comes through the web app's own request.
vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return { ...actual, Link: ({ children }: { children: React.ReactNode }) => <a href="#link">{children}</a> };
});

const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: '00000000-0000-4000-8000-000000000001',
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
    { type: 'test', label: 'Test message', maxMode: 'act', available: false },
    { type: 'pod_chase', label: 'Chase a missing POD', maxMode: 'act', available: false },
    { type: 'invoice_delivery', label: 'Send an invoice', maxMode: 'draft', available: true },
    { type: 'payment_reminder', label: 'Payment reminder', maxMode: 'act', available: true },
    { type: 'broker_message', label: 'Message to a broker', maxMode: 'draft', available: false },
    { type: 'detention_claim', label: 'Detention claim', maxMode: 'draft', available: false },
  ],
  ...over,
});

interface World {
  role: string;
  messages: OutboundMessage[];
  settings: OutboundSettingsResponse;
  mailbox: { connected: boolean; status: string; provider: string | null; connectedAt: string | null };
}

function renderScreen(world: Partial<World> = {}) {
  const w: World = {
    role: 'owner',
    messages: [],
    settings: settings(),
    mailbox: { connected: true, status: 'connected', provider: 'GOOGLE', connectedAt: null },
    ...world,
  };
  writeSession({ userId: 'user-1', orgId: 'org-1' });
  vi.mocked(request).mockImplementation(async (path: string) => {
    if (path === '/v1/orgs') return { items: [{ id: 'org-1', name: 'Prairie Freight', role: w.role, status: 'active' }] };
    throw new Error(`unexpected web request: ${path}`);
  });
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client: ApiClient = {
    request: vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: options?.method ?? 'GET', body: options?.body });
      if (path === '/v1/outbound/settings' && !options?.method) return w.settings;
      if (path.startsWith('/v1/outbound/messages') && !options?.method) return { messages: w.messages };
      if (path === '/v1/mailbox') return w.mailbox;
      if (path.endsWith('/approve')) return { ...w.messages[0], status: 'sent' };
      return { ok: true };
    }) as ApiClient['request'],
    requestBlob: vi.fn(async () => new Blob(['%PDF-'])),
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <AutopilotScreen />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, client };
}

beforeEach(() => vi.clearAllMocks());

describe('AutopilotScreen — reviewing', () => {
  it('opens on what is waiting, shows the whole message, and approves it', async () => {
    const { calls } = renderScreen({ messages: [message()] });

    expect(await screen.findByText('Payment reminder — 2 invoices')).toBeInTheDocument();
    expect(screen.getByText('ap@prairie.example.com')).toBeInTheDocument();
    expect(screen.getByText(/This is a friendly reminder/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Needs your OK/ })).toHaveAttribute('aria-selected', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/outbound/messages/00000000-0000-4000-8000-000000000001/approve')).toBe(true),
    );
  });

  it('rejects without sending', async () => {
    const { calls } = renderScreen({ messages: [message()] });
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/reject') && c.method === 'POST')).toBe(true));
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
  });

  it('lets a reviewer open the real attachment', async () => {
    const attachments = [{ kind: 'invoice' as const, refId: '00000000-0000-4000-8000-0000000000bb', filename: 'Invoice-1042.pdf', contentType: 'application/pdf', byteSize: null }];
    const { client } = renderScreen({ messages: [message({ actionType: 'invoice_delivery', attachments })] });
    window.open = vi.fn(() => ({ location: { href: '' }, close: vi.fn() }) as unknown as Window);
    URL.createObjectURL = vi.fn(() => 'blob:x');

    await userEvent.click(await screen.findByRole('button', { name: /Invoice-1042\.pdf/ }));

    await waitFor(() => expect(client.requestBlob).toHaveBeenCalledWith('/v1/invoices/00000000-0000-4000-8000-0000000000bb/pdf'));
  });

  it('cannot approve while sending is switched off, and says so', async () => {
    renderScreen({ messages: [message()], settings: settings({ sendingEnabled: false }) });
    expect(await screen.findByRole('button', { name: 'Approve and send' })).toBeDisabled();
    expect(screen.getByText(/Sending from your mailbox is switched off/)).toBeInTheDocument();
  });

  it('shows previews with the reason they were held, and problems with what went wrong', async () => {
    renderScreen({
      messages: [
        message({ id: '00000000-0000-4000-8000-000000000002', status: 'shadow', holdReason: 'sending_disabled', subject: 'A preview' }),
        message({ id: '00000000-0000-4000-8000-000000000003', status: 'failed', error: 'A file was missing.', subject: 'A failure' }),
      ],
    });
    await userEvent.click(await screen.findByRole('tab', { name: /Would have sent/ }));
    expect(screen.getByText('A preview')).toBeInTheDocument();
    expect(screen.getByText(/Held because sending from your mailbox is switched off/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Problems/ }));
    expect(screen.getByText('A failure')).toBeInTheDocument();
    expect(screen.getByText('A file was missing.')).toBeInTheDocument();
  });

  it('warns when the loop is not running on this server', async () => {
    renderScreen({ settings: settings({ autopilotRunning: false }) });
    expect(await screen.findByText(/not switched on for this HaulQ server/)).toBeInTheDocument();
  });

  it('never shows the server’s words for the modes', async () => {
    renderScreen({ messages: [message()] });
    await screen.findByText('Payment reminder — 2 invoices');
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByText('What Autopilot does');
    expect(document.body.textContent ?? '').not.toMatch(/shadow|\bdraft\b/i);
  });
});

describe('AutopilotScreen — roles', () => {
  it('gives an accountant the review tabs but no settings', async () => {
    renderScreen({ role: 'accountant', messages: [message()] });
    await screen.findByText('Payment reminder — 2 invoices');
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeEnabled();
  });

  it('lets a dispatcher approve, and look at settings without changing them', async () => {
    renderScreen({ role: 'dispatcher', messages: [message()] });
    expect(await screen.findByRole('button', { name: 'Approve and send' })).toBeEnabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByText(/Only the owner can change these/)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('tells a driver it is not theirs', async () => {
    renderScreen({ role: 'driver' });
    expect(await screen.findByText(/Your role does not include it/)).toBeInTheDocument();
  });
});

describe('AutopilotScreen — settings', () => {
  const open = async () => {
    const utils = renderScreen({ messages: [message()] });
    await screen.findByText('Payment reminder — 2 invoices');
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByText('What Autopilot does');
    return utils;
  };

  it('offers only the actions a loop really drives', async () => {
    await open();
    expect(screen.getByRole('radiogroup', { name: 'Invoice emails' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Payment reminders' })).toBeInTheDocument();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
  });

  it('will not let invoices be sent automatically, but will for reminders', async () => {
    await open();
    const invoices = within(screen.getByRole('radiogroup', { name: 'Invoice emails' }));
    const reminders = within(screen.getByRole('radiogroup', { name: 'Payment reminders' }));
    expect(invoices.getByRole('radio', { name: 'Send automatically' })).toBeDisabled();
    expect(reminders.getByRole('radio', { name: 'Send automatically' })).toBeEnabled();
    expect(invoices.getByRole('radio', { name: 'Ask me first' })).toHaveAttribute('aria-checked', 'true');
  });

  it('turns an action off by clearing it, and sets a mode for anything else', async () => {
    const { calls } = await open();
    const reminders = within(screen.getByRole('radiogroup', { name: 'Payment reminders' }));

    await userEvent.click(reminders.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/outbound/settings/payment_reminder')).toBe(true));

    await userEvent.click(reminders.getByRole('radio', { name: 'Show me first' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && JSON.stringify(c.body) === JSON.stringify({ modes: { payment_reminder: 'shadow' } }))).toBe(true),
    );
  });

  it('makes “off” unmistakable, and will not turn sending on without a mailbox', async () => {
    renderScreen({
      messages: [message()],
      settings: settings({ sendingEnabled: false }),
      mailbox: { connected: false, status: 'not_connected', provider: null, connectedAt: null },
    });
    await screen.findByText('Payment reminder — 2 invoices');
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByText(/Sending from your mailbox is OFF/)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect mailbox' })).toBeEnabled();
  });
});
