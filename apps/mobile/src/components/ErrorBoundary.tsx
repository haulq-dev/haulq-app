/**
 * The difference between a white screen and a screen that says why.
 *
 * Nothing here caught a render error before this — Clerk's provider in
 * particular throws synchronously on a misconfigured key or an origin it
 * doesn't recognize, and with no boundary React just unmounts, leaving a
 * blank WebView with no way to tell "crashed" apart from "still loading" or
 * "shipped broken." This is deliberately loud (the raw error name and
 * message, not a friendly rewrite) — the audience for this screen is
 * whoever is debugging a build, not a driver mid-shift.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No crash-reporting service wired up yet — the console is the only
    // place this goes today, alongside the on-screen message below.
    console.error('HaulQ Driver crashed:', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} />;
    }
    return this.props.children;
  }
}

function CrashScreen({ error }: { error: Error }) {
  return (
    <div className="mx-auto max-w-md space-y-3 px-6 py-16">
      <h1 className="text-xl text-bad">Something went wrong</h1>
      <p className="text-sm text-slate">
        {error.name}: {error.message}
      </p>
      {error.stack && (
        <pre className="max-h-64 overflow-auto border border-line bg-wash p-2 text-xs whitespace-pre-wrap">
          {error.stack}
        </pre>
      )}
      <button className="hq-btn hq-btn-ghost" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
