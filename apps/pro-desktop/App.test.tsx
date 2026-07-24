import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const {
  mockAppRouterProvider,
  mockPrintDocument,
  mockPrintEurDocument,
} = vi.hoisted(() => ({
  mockAppRouterProvider: vi.fn(() => <div data-testid="app-router-provider" />),
  mockPrintDocument: vi.fn((props: { kind: 'invoice' | 'offer'; id: string }) => (
    <div data-testid="print-document">
      {props.kind}:{props.id}
    </div>
  )),
  mockPrintEurDocument: vi.fn((props: { taxYear: number; from?: string; to?: string }) => (
    <div data-testid="print-eur-document">
      {props.taxYear}:{props.from ?? 'none'}:{props.to ?? 'none'}
    </div>
  )),
}));

vi.mock('./router', () => ({
  AppRouterProvider: mockAppRouterProvider,
}));

vi.mock('@billme/desktop-renderer/components/PrintDocument', () => ({
  PrintDocument: mockPrintDocument,
}));

vi.mock('@billme/desktop-renderer/components/PrintEurDocument', () => ({
  PrintEurDocument: mockPrintEurDocument,
}));

import App from './App';

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppRouterProvider.mockImplementation(() => <div data-testid="app-router-provider" />);
    mockPrintDocument.mockImplementation((props: { kind: 'invoice' | 'offer'; id: string }) => (
      <div data-testid="print-document">
        {props.kind}:{props.id}
      </div>
    ));
    mockPrintEurDocument.mockImplementation((props: { taxYear: number; from?: string; to?: string }) => (
      <div data-testid="print-eur-document">
        {props.taxYear}:{props.from ?? 'none'}:{props.to ?? 'none'}
      </div>
    ));
    window.history.pushState({}, '', '/');
  });

  it('renders router provider in normal app mode', () => {
    render(<App />);

    expect(screen.getByTestId('app-router-provider')).toBeInTheDocument();
    expect(mockAppRouterProvider).toHaveBeenCalledTimes(1);
    expect(mockPrintDocument).not.toHaveBeenCalled();
    expect(mockPrintEurDocument).not.toHaveBeenCalled();
  });

  it('renders invoice print mode by default when __print=1 and kind is missing', () => {
    window.history.pushState({}, '', '/?__print=1&id=inv-1');
    render(<App />);

    expect(screen.getByTestId('print-document')).toBeInTheDocument();
    expect(mockPrintDocument).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invoice', id: 'inv-1' }),
      undefined,
    );
    expect(mockAppRouterProvider).not.toHaveBeenCalled();
    expect(mockPrintEurDocument).not.toHaveBeenCalled();
  });

  it('renders offer print mode when kind=offer', () => {
    window.history.pushState({}, '', '/?__print=1&kind=offer&id=off-77');
    render(<App />);

    expect(screen.getByTestId('print-document')).toBeInTheDocument();
    expect(mockPrintDocument).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'offer', id: 'off-77' }),
      undefined,
    );
    expect(mockAppRouterProvider).not.toHaveBeenCalled();
    expect(mockPrintEurDocument).not.toHaveBeenCalled();
  });

  it('renders EUR print mode with defaults when kind=eur and params are missing', () => {
    window.history.pushState({}, '', '/?__print=1&kind=eur');
    render(<App />);

    expect(screen.getByTestId('print-eur-document')).toBeInTheDocument();
    expect(mockPrintEurDocument).toHaveBeenCalledWith(
      expect.objectContaining({ taxYear: 2025, from: undefined, to: undefined }),
      undefined,
    );
    expect(mockPrintDocument).not.toHaveBeenCalled();
    expect(mockAppRouterProvider).not.toHaveBeenCalled();
  });

  it('passes EUR query params to print document', () => {
    window.history.pushState(
      {},
      '',
      '/?__print=1&kind=eur&taxYear=2024&from=2024-01-01&to=2024-12-31',
    );
    render(<App />);

    expect(screen.getByTestId('print-eur-document')).toBeInTheDocument();
    expect(mockPrintEurDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        taxYear: 2024,
        from: '2024-01-01',
        to: '2024-12-31',
      }),
      undefined,
    );
    expect(mockPrintDocument).not.toHaveBeenCalled();
    expect(mockAppRouterProvider).not.toHaveBeenCalled();
  });

  it('shows ErrorBoundary fallback when child rendering fails', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAppRouterProvider.mockImplementation(() => {
      throw new Error('router exploded');
    });

    render(<App />);

    expect(screen.getByText('Fehler aufgetreten')).toBeInTheDocument();
    expect(screen.getByText('router exploded')).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});
