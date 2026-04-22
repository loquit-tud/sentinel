import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console; in production wire to Sentry/etc.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-sentinel-surface border border-sentinel-danger/30 rounded-2xl p-6 text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-full bg-sentinel-danger/15 flex items-center justify-center text-2xl">
            ⚠️
          </div>
          <div>
            <h2 className="text-lg font-bold text-white mb-1">Something broke</h2>
            <p className="text-sm text-gray-400">
              {this.state.error?.message?.slice(0, 200) || 'An unexpected error occurred.'}
            </p>
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={this.reset}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-sentinel-accent/15 text-sentinel-accent border border-sentinel-accent/25 hover:bg-sentinel-accent/25 transition-all"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-sm font-medium rounded-lg text-gray-400 border border-sentinel-border hover:text-white hover:bg-white/5 transition-all"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
