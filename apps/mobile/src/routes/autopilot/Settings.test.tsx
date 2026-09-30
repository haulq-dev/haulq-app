import type { OutboundSettingsResponse } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { request } from '../../lib/api.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { AutopilotSettingsScreen } from './SettingsScreen.tsx';

const settings = (over: Partial<OutboundSettingsResponse> = {}): OutboundSettingsResponse => ({
  sendingEnabled: true,
  autopilotRunning: true,
  modes: {},
  configured: { invoice_delivery: 'draft' },
  actions: [
    { type: 'invoice_delivery', label: 'Send an invoice', maxMode: 'draft', available: true },
    { type: 'payment_reminder', label: 'Payment reminder', maxMode: 'act', available: true },
    { type: 'detention_claim', label: 'Detention claim', maxMode: 'draft', available: false },
  ],
  ...over,
});

const MAILBOX = { connected: true, status: 'connected', provider: 'GOOGLE', connectedAt: null, configured: true };

function world(over: { settings?: OutboundSettingsResponse; mailbox?: Record<string, unknown> } = {}) {
  answerRequests({
    '/v1/outbound/settings': (o: { method?: string } | undefined) => (o?.method ? { ok: true } : (over.settings ?? settings())),
    '/v1/outbound/settings/': { ok: true },
    '/v1/outbound/evidence': { actions: {} },
    '/v1/outbound/test': { message: { status: 'sent' }, sent: true },
    '/v1/mailbox': over.mailbox ?? MAILBOX,
  });
}

const calls = (method: string) =>
  (request as Mock).mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === method).map(([p, o]) => [p, (o as { body?: unknown }).body]);

beforeEach(() => {
  (request as Mock).mockReset();
  session.current = { ...session.current, role: 'owner' };
});

describe('AutopilotSettingsScreen', () => {
  it('shows each action with its current position, and only the ones a loop drives', async () => {
    world();
    renderScreen(<AutopilotSettingsScreen />);

    const invoice = await screen.findByRole('radiogroup', { name: 'Invoice emails' });
    expect(invoice).toBeInTheDocument();
    expect(screen.getAllByRole('radio', { name: 'Ask me first', checked: true })).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: /Detention/ })).not.toBeInTheDocument();
  });

  it('will not offer a position above the action’s ceiling, and says why', async () => {
    world();
    renderScreen(<AutopilotSettingsScreen />);
    await screen.findByRole('radiogroup', { name: 'Invoice emails' });

    const autos = screen.getAllByRole('radio', { name: 'Send automatically' });
    expect(autos[0]).toBeDisabled();
    expect(autos[1]).toBeEnabled();
    expect(screen.getByText(/always needs your OK before it goes out/)).toBeInTheDocument();
  });

  it('moves an action to a new position, and turning one off removes it', async () => {
    world();
    renderScreen(<AutopilotSettingsScreen />);
    await screen.findByRole('radiogroup', { name: 'Payment reminders' });

    const [, reminderPreview] = screen.getAllByRole('radio', { name: 'Show me first' });
    await userEvent.click(reminderPreview!);
    await waitFor(() => expect(calls('PUT')).toContainEqual(['/v1/outbound/settings', { modes: { payment_reminder: 'shadow' } }]));

    const [invoiceOff] = screen.getAllByRole('radio', { name: 'Off' });
    await userEvent.click(invoiceOff!);
    await waitFor(() => expect(calls('DELETE').map(([p]) => p)).toContain('/v1/outbound/settings/invoice_delivery'));
  });

  it('turns sending back on, which needs a connected mailbox', async () => {
    world({ settings: settings({ sendingEnabled: false }) });
    renderScreen(<AutopilotSettingsScreen />);

    await userEvent.click(await screen.findByRole('switch', { name: 'Turn sending on' }));
    await waitFor(() => expect(calls('PUT')).toContainEqual(['/v1/outbound/settings', { sendingEnabled: true }]));
  });

  it('cannot turn sending on without a mailbox', async () => {
    world({ settings: settings({ sendingEnabled: false }), mailbox: { ...MAILBOX, connected: false, status: 'not_connected' } });
    renderScreen(<AutopilotSettingsScreen />);
    expect(await screen.findByRole('switch', { name: 'Turn sending on' })).toBeDisabled();
    expect(screen.getByText(/Connect a mailbox first/)).toBeInTheDocument();
  });

  it('asks before stopping', async () => {
    world();
    window.confirm = vi.fn(() => false);
    renderScreen(<AutopilotSettingsScreen />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Stop sending' }));
    expect(calls('PUT')).toHaveLength(0);
  });

  it('shows a dispatcher how it is set, with nothing to change', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    world();
    renderScreen(<AutopilotSettingsScreen />);
    expect(await screen.findByText(/Only the owner can change these/)).toBeInTheDocument();
    await screen.findByRole('radiogroup', { name: 'Invoice emails' });
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send myself a test message' })).not.toBeInTheDocument();
  });

  it('hides the mailbox while the server has no mailbox provider, and says why sending cannot go on', async () => {
    world({ settings: settings({ sendingEnabled: false }), mailbox: { ...MAILBOX, connected: false, configured: false } });
    renderScreen(<AutopilotSettingsScreen />);
    expect(await screen.findByText(/Sending from your own email isn’t available yet/)).toBeInTheDocument();
    expect(screen.queryByText('Your mailbox')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Turn sending on' })).toBeDisabled();
  });

  it('sends the owner a test message', async () => {
    world();
    renderScreen(<AutopilotSettingsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send myself a test message' }));
    expect(await screen.findByText('Sent. Check your inbox.')).toBeInTheDocument();
  });
});
