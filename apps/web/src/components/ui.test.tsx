import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton, ToastProvider, useToast } from './ui.tsx';

describe('ConfirmButton', () => {
  const setup = () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton question="Past loads keep their name." confirmLabel="Take Sam off" onConfirm={onConfirm}>
        Take off the roster
      </ConfirmButton>,
    );
    return onConfirm;
  };

  it('asks before acting, and acts on confirm', async () => {
    const onConfirm = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Take off the roster' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('Past loads keep their name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take Sam off' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Take Sam off' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Take off the roster' })).toBeInTheDocument();
  });

  it('backs out on Cancel or Escape without acting', async () => {
    const onConfirm = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Take off the roster' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Take off the roster' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Take off the roster' })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('toasts', () => {
  function Saver() {
    const toast = useToast();
    return <button onClick={() => toast('Invoice 12 marked sent')}>Save</button>;
  }

  it('announces in the live region, then goes away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Saver />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('status')).toHaveTextContent('Invoice 12 marked sent');

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    vi.useRealTimers();
  });

  it('does nothing outside a provider, so screens render alone under test', async () => {
    render(<Saver />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
