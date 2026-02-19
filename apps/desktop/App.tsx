
import React from 'react';
import { AppRouterProvider } from './router';
import { PrintDocument } from './components/PrintDocument';
import { PrintEurDocument } from './components/PrintEurDocument';
import { ErrorBoundary } from './components/ErrorBoundary';

const App: React.FC = () => {
  const params = new URLSearchParams(window.location.search);
  const isPrint = params.get('__print') === '1';
  if (isPrint) {
    const kind = params.get('kind');
    if (kind === 'eur') {
      const taxYear = Number(params.get('taxYear') ?? '2025');
      const from = params.get('from') ?? undefined;
      const to = params.get('to') ?? undefined;
      return (
        <ErrorBoundary>
          <PrintEurDocument taxYear={taxYear} from={from} to={to} />
        </ErrorBoundary>
      );
    }
    const docKind = kind === 'offer' ? 'offer' : 'invoice';
    const id = params.get('id') ?? '';
    return (
      <ErrorBoundary>
        <PrintDocument kind={docKind} id={id} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppRouterProvider />
    </ErrorBoundary>
  );
};

export default App;
