import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };
const permission = { current: 'granted' as string };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../../lib/push.ts', () => ({
  pushPermission: vi.fn(async () => permission.current),
  askForPush: vi.fn(async () => 'granted'),
  promptDismissed: vi.fn(() => false),
  dismissPrompt: vi.fn(),
}));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { request } from '../../lib/api.ts';
import { askForPush, dismissPrompt } from '../../lib/push.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { PushPrompt } from '../../components/PushPrompt.tsx';
import { NotificationsScreen } from './NotificationsScreen.tsx';

beforeEach(() => {
  (request as Mock).mockReset();
  (askForPush as Mock).mockClear();
  session.current = { ...session.current, role: 'owner' };
  permission.current = 'granted';
});

describe('NotificationsScreen', () => {
  it("lists only the owner's categories, and switching one off saves it", async () => {
    const saved: unknown[] = [];
    answerRequests({
      '/v1/push/preferences': (o: { method?: string; body?: unknown } | undefined) => {
        if (o?.method === 'PUT') {
          saved.push(o.body);
          return o.body;
        }
        return { muted: [] };
      },
    });
    renderScreen(<NotificationsScreen />);

    const quiet = await screen.findByRole('switch', { name: 'A load went quiet' });
    expect(quiet).toBeChecked();
    expect(screen.getByRole('switch', { name: 'An invoice was paid' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'A load assigned to you' })).not.toBeInTheDocument();

    await waitFor(() => expect(quiet).toBeEnabled());
    await userEvent.click(quiet);
    await waitFor(() => expect(saved).toEqual([{ muted: ['load_quiet'] }]));
  });

  it('gives a driver only their one kind', async () => {
    session.current = { ...session.current, role: 'driver' };
    answerRequests({ '/v1/push/preferences': { muted: [] } });
    renderScreen(<NotificationsScreen />);
    expect(await screen.findByRole('switch', { name: 'A load assigned to you' })).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });

  it('sends a test to this phone', async () => {
    answerRequests({ '/v1/push/preferences': { muted: [] }, '/v1/push/test': { sent: 1 } });
    renderScreen(<NotificationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send a test notification' }));
    expect(await screen.findByText(/should arrive in a few seconds/)).toBeInTheDocument();
  });

  it('says where to turn them on when iOS has them off', async () => {
    permission.current = 'denied';
    answerRequests({ '/v1/push/preferences': { muted: [] } });
    renderScreen(<NotificationsScreen />);
    expect(await screen.findByText(/Turn them on in the iPhone’s Settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a test notification' })).not.toBeInTheDocument();
  });
});

describe('PushPrompt', () => {
  it('asks only while the answer is open, and says what for', async () => {
    permission.current = 'prompt';
    renderScreen(<PushPrompt forDriver={false} />);
    expect(await screen.findByText(/when a load goes quiet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(askForPush).toHaveBeenCalled();
  });

  it('remembers Not now', async () => {
    permission.current = 'prompt';
    renderScreen(<PushPrompt forDriver />);
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(dismissPrompt).toHaveBeenCalled();
    expect(screen.queryByText('Get notified')).not.toBeInTheDocument();
  });

  it('shows nothing once permission is decided', async () => {
    permission.current = 'granted';
    const { container } = renderScreen(<PushPrompt forDriver />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
