import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { request, writeSession } from '../lib/api.ts';
import { IntegrationsScreen } from './Integrations.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntegrationsScreen />
    </QueryClientProvider>,
  );
}

describe('IntegrationsScreen — deployment status', () => {
  it('shows each optional integration as configured or not, from the real response', async () => {
    writeSession({ userId: 'user-1', orgId: 'org-1' });
    vi.mocked(request).mockImplementation(async (path: string) => {
      if (path === '/v1/orgs') return { items: [{ id: 'org-1', name: 'Prairie Freight', role: 'owner' }] };
      if (path === '/v1/integrations') {
        return {
          items: [],
          deployment: {
            azureDocumentIntelligence: { configured: true },
            anthropicModelPass: { configured: false },
            fmcsaVerify: { configured: true },
            hereRouting: { configured: false },
            motive: { configured: false },
          },
        };
      }
      throw new Error(`unexpected request: ${path}`);
    });

    renderScreen();

    await screen.findByText('Deployment status');
    expect(screen.getByText('Docs — Azure OCR').nextSibling).toHaveTextContent('Configured');
    expect(screen.getByText('Docs — model pass').nextSibling).toHaveTextContent('Not configured');
    expect(screen.getByText('Verify — FMCSA').nextSibling).toHaveTextContent('Configured');
    expect(screen.getByText('Routes — HERE').nextSibling).toHaveTextContent('Not configured');
    expect(screen.getByText('Track — Motive').nextSibling).toHaveTextContent('Not configured');
  });
});
