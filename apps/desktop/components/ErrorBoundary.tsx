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
    return { hasError: true };
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

    // Here you could send error to external logging service
    // Example: Sentry, LogRocket, etc.
    try {
      const errorLog = {
        timestamp: new Date().toISOString(),
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        isDev,
      };
      console.error('Error Log:', errorLog);
      // Could send to backend or external service here
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

      // Default error UI
      const isDev = process.env.NODE_ENV === 'development';

      return (
        <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-error-bg to-error-bg/50 p-4">
          <div className="w-full max-w-md">
            {/* Header */}
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-error-bg mb-4">
                <AlertTriangle size={32} className="text-error" />
              </div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Fehler aufgetreten
              </h1>
              <p className="text-gray-600">
                Die Anwendung ist auf einen Fehler gestoßen.
              </p>
            </div>

            {/* Error Details */}
            <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
              <div className="mb-4">
                <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">
                  Fehlerdetails
                </h2>
                <div className="bg-error-bg border border-error/30 rounded-lg p-4 max-h-48 overflow-y-auto">
                  <p className="text-sm font-mono text-error break-words">
                    {this.state.error.message || 'Unbekannter Fehler'}
                  </p>
                </div>
              </div>

              {isDev && this.state.errorInfo && (
                <div>
                  <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">
                    Stack Trace
                  </h2>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 max-h-48 overflow-y-auto">
                    <p className="text-xs font-mono text-gray-700 whitespace-pre-wrap break-words">
                      {this.state.errorInfo.componentStack}
                    </p>
                  </div>
                </div>
              )}

              {this.state.errorCount > 2 && (
                <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-xs text-yellow-800 font-medium">
                    ⚠️ Mehrere Fehler erkannt ({this.state.errorCount}).
                    Ein Neustart wird empfohlen.
                  </p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="space-y-3">
              {this.state.errorCount <= 2 ? (
                <>
                  <button
                    onClick={this.handleReset}
                    className="w-full flex items-center justify-center gap-2 bg-info hover:bg-info/90 text-white font-bold py-3 px-4 rounded-xl transition-colors shadow-md"
                  >
                    <RefreshCw size={18} />
                    Erneut versuchen
                  </button>
                  <button
                    onClick={this.handleReload}
                    className="w-full flex items-center justify-center gap-2 bg-gray-200 hover:bg-gray-300 text-gray-900 font-bold py-3 px-4 rounded-xl transition-colors"
                  >
                    <Home size={18} />
                    Anwendung neu laden
                  </button>
                </>
              ) : (
                <button
                  onClick={this.handleReload}
                  className="w-full flex items-center justify-center gap-2 bg-error hover:bg-error/90 text-white font-bold py-3 px-4 rounded-xl transition-colors shadow-md"
                >
                  <RefreshCw size={18} />
                  Anwendung neu laden
                </button>
              )}
            </div>

            {/* Support Info */}
            <div className="mt-8 p-4 bg-info-bg border border-info/30 rounded-lg">
              <p className="text-xs text-info">
                <strong>Tipp:</strong> Wenn dieser Fehler weiterhin auftritt,
                versuchen Sie den Browser-Cache zu leeren oder wenden Sie sich
                an den Support.
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
 * Async Error Boundary - catches errors from async operations
 * Use this wrapper for routes/components that may have async operations
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
    return { hasError: true };
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
