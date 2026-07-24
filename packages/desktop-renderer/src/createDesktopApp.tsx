import React from 'react';
import { PrintDocument } from './components/PrintDocument';
import { PrintEurDocument } from './components/PrintEurDocument';

type BoundaryProps = {
  children: React.ReactNode;
};

export const createDesktopApp = (
  RouterProvider: React.ComponentType,
  ErrorBoundary: React.ComponentType<BoundaryProps>,
): React.FC => {
  const DesktopApp: React.FC = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('__print') !== '1') {
      return (
        <ErrorBoundary>
          <RouterProvider />
        </ErrorBoundary>
      );
    }

    if (params.get('kind') === 'eur') {
      return (
        <ErrorBoundary>
          <PrintEurDocument
            taxYear={Number(params.get('taxYear') ?? '2025')}
            from={params.get('from') ?? undefined}
            to={params.get('to') ?? undefined}
          />
        </ErrorBoundary>
      );
    }

    return (
      <ErrorBoundary>
        <PrintDocument
          kind={params.get('kind') === 'offer' ? 'offer' : 'invoice'}
          id={params.get('id') ?? ''}
        />
      </ErrorBoundary>
    );
  };

  return DesktopApp;
};
