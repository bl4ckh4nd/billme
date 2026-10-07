import React, { ReactNode, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button, Card, IconTile } from '@billme/ui';

// Vite replaces `process.env.NODE_ENV` at build time. Declared module-locally so
// browser tsconfigs without Node types accept it; Node-typed apps are unaffected.
declare const process: { env: { NODE_ENV?: string } };

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
        <div className="flex min-h-screen items-center justify-center bg-ground p-4">
          <div className="flex w-full max-w-md flex-col gap-3.5">
            <div className="flex flex-col items-center gap-2 text-center">
              <IconTile tone="error" icon={<AlertTriangle size={16} />} />
              <h1 className="text-title text-foreground">
                Diese Ansicht konnte nicht geladen werden
              </h1>
              <p className="text-control text-muted">
                Billme hat beim Laden der Ansicht einen Fehler festgestellt.
              </p>
            </div>

            <Card className="flex flex-col gap-3">
              <div>
                <h2 className="mb-1.5 text-eyebrow uppercase text-muted">
                  Fehlerdetails
                </h2>
                <div className="max-h-48 overflow-y-auto rounded-control border border-error-border bg-error-bg px-3 py-2.5">
                  <p className="break-words font-mono text-control text-error-text">
                    {this.state.error.message || 'Unbekannter Fehler'}
                  </p>
                </div>
              </div>

              {isDev && this.state.errorInfo && (
                <div>
                  <h2 className="mb-1.5 text-eyebrow uppercase text-muted">
                    Stack Trace
                  </h2>
                  <div className="max-h-48 overflow-y-auto rounded-control border border-border bg-surface-sunken px-3 py-2.5">
                    <p className="whitespace-pre-wrap break-words font-mono text-caption text-foreground">
                      {this.state.errorInfo.componentStack}
                    </p>
                  </div>
                </div>
              )}

              {this.state.errorCount > 2 && (
                <p className="rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text">
                  Mehrere Fehler erkannt ({this.state.errorCount}).
                  Bitte starte die Anwendung neu.
                </p>
              )}
            </Card>

            <div className="flex flex-col gap-2">
              {this.state.errorCount <= 2 ? (
                <>
                  <Button fullWidth onClick={this.handleReset}>
                    <RefreshCw size={16} aria-hidden="true" />
                    Erneut versuchen
                  </Button>
                  <Button fullWidth variant="secondary" onClick={this.handleReload}>
                    <Home size={16} aria-hidden="true" />
                    Anwendung neu laden
                  </Button>
                </>
              ) : (
                <Button fullWidth variant="danger" onClick={this.handleReload}>
                  <RefreshCw size={16} aria-hidden="true" />
                  Anwendung neu laden
                </Button>
              )}
            </div>

            <p className="rounded-control border border-info-border bg-info-bg px-3 py-2.5 text-control text-info-text">
              <strong className="font-semibold">Nächster Schritt:</strong> Starte die Anwendung neu. Wenn der Fehler wieder auftritt,
              sende die Fehlerdetails an den Support.
            </p>
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
