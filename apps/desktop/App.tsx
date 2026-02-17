
import React from 'react';
import { AppRouterProvider } from './router';
import { PrintDocument } from './components/PrintDocument';
import { ErrorBoundary } from './components/ErrorBoundary';

const App: React.FC = () => {
  const params = new URLSearchParams(window.location.search);
  const isPrint = params.get('__print') === '1';
  if (isPrint) {
    const kind = params.get('kind') === 'offer' ? 'offer' : 'invoice';
    const id = params.get('id') ?? '';
    return (
      <ErrorBoundary>
        <PrintDocument kind={kind} id={id} />
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
