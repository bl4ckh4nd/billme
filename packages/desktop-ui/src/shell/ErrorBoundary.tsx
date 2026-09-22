import React, { ReactNode, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  errorCount: number;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // The error has to be in the derived state: the fallback renders from the
    // same pass, and rendering the failed children again would rethrow.
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const isDev = process.env.NODE_ENV === 'development';

    // Log to console in development
    if (isDev) {
      console.error('Error caught by boundary:', error, errorInfo);
    }

    this.setState(prev => ({
      error,
      errorInfo,
      errorCount: prev.errorCount + 1,
    }));

    try {
      const errorLog = {
        timestamp: new Date().toISOString(),
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        isDev,
      };
      console.error('Error Log:', errorLog);
    } catch (logError) {
      console.error('Failed to log error:', logError);
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError && this.state.error) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }

      const isDev = process.env.NODE_ENV === 'development';

      return (
        <div className="flex items-center justify-center min-h-screen bg-surface-sunken p-4">
          <div className="w-full max-w-md">
            {/* Header */}
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-error-bg border border-error-border mb-4">
                <AlertTriangle size={32} className="text-error-text" aria-hidden="true" />
              </div>
              <h1 className="text-3xl font-bold text-foreground mb-2">
                Diese Ansicht konnte nicht geladen werden
              </h1>
              <p className="text-muted">
                Billme hat beim Laden der Ansicht einen Fehler festgestellt.
              </p>
            </div>

            {/* Error Details */}
            <div className="bg-surface rounded-xl border border-error-border p-6 mb-6">
              <div className="mb-4">
                <h2 className="text-sm font-bold text-muted uppercase tracking-wide mb-2">
                  Fehlerdetails
                </h2>
                <div className="bg-error-bg border border-error-border rounded-md p-4 max-h-48 overflow-y-auto">
                  <p className="text-sm font-mono text-error-text break-words">
                    {this.state.error.message || 'Unbekannter Fehler'}
                  </p>
                </div>
              </div>

              {isDev && this.state.errorInfo && (
                <div>
                  <h2 className="text-sm font-bold text-muted uppercase tracking-wide mb-2">
                    Stack Trace
                  </h2>
                  <div className="bg-surface-muted border border-border rounded-md p-4 max-h-48 overflow-y-auto">
                    <p className="text-xs font-mono text-foreground whitespace-pre-wrap break-words">
                      {this.state.errorInfo.componentStack}
                    </p>
                  </div>
                </div>
              )}

              {this.state.errorCount > 2 && (
                <div className="mt-4 p-3 bg-warning-bg border border-warning-border rounded-md">
                  <p className="text-xs text-warning-text font-medium">
                    Mehrere Fehler erkannt ({this.state.errorCount}).
                    Bitte starte die Anwendung neu.
                  </p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="space-y-3">
              {this.state.errorCount <= 2 ? (
                <>
                  <button
                    type="button"
                    onClick={this.handleReset}
                    className="w-full flex items-center justify-center gap-2 bg-dark-base hover:bg-dark-2 text-background font-bold py-3 px-4 rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <RefreshCw size={18} aria-hidden="true" />
                    Erneut versuchen
                  </button>
                  <button
                    type="button"
                    onClick={this.handleReload}
                    className="w-full flex items-center justify-center gap-2 bg-surface-muted hover:bg-border text-foreground font-bold py-3 px-4 rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <Home size={18} aria-hidden="true" />
                    Anwendung neu laden
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={this.handleReload}
                  className="w-full flex items-center justify-center gap-2 bg-error-text hover:bg-error text-background font-bold py-3 px-4 rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <RefreshCw size={18} aria-hidden="true" />
                  Anwendung neu laden
                </button>
              )}
            </div>

            {/* Support Info */}
            <div className="mt-8 p-4 bg-info-bg border border-info-border rounded-md">
              <p className="text-xs text-info-text">
                <strong>Nächster Schritt:</strong> Starte die Anwendung neu. Wenn der Fehler wieder auftritt,
                sende die Fehlerdetails an den Support.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Async Error Boundary, for routes and components that run async operations.
 */
interface AsyncErrorBoundaryProps extends ErrorBoundaryProps {
  onError?: (error: Error) => void;
}

export class AsyncErrorBoundary extends React.Component<
  AsyncErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: AsyncErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo, errorCount: this.state.errorCount + 1 });
    this.props.onError?.(error);
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }
      return <ErrorBoundary>{this.props.children}</ErrorBoundary>;
    }

    return this.props.children;
  }
}
