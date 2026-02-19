import React from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ipc } from '../ipc/client';

const printQueryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});

interface Props {
  taxYear: number;
  from?: string;
  to?: string;
}

const formatEur = (amount: number): string =>
  new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);

const formatDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

export const PrintEurDocument: React.FC<Props> = (props) => (
  <QueryClientProvider client={printQueryClient}>
    <PrintEurInner {...props} />
  </QueryClientProvider>
);

const PrintEurInner: React.FC<Props> = ({ taxYear, from, to }) => {
  const { data: report } = useQuery({
    queryKey: ['eur', 'report', taxYear, from, to],
    queryFn: () => ipc.eur.getReport({ taxYear, from, to }),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => ipc.settings.get(),
  });

  React.useEffect(() => {
    (globalThis as any).__PDF_READY__ = false;
  }, []);

  React.useEffect(() => {
    if (!report || !settings) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        (globalThis as any).__PDF_READY__ = true;
      });
    });
  }, [report, settings]);

  if (!report || !settings) return null;

  const incomeRows = report.rows.filter((r) => r.exportable && (r.kind === 'income' || (r.kind === 'computed' && r.lineId.includes('KZ159'))));
  const expenseRows = report.rows.filter((r) => r.exportable && (r.kind === 'expense' || (r.kind === 'computed' && r.lineId.includes('KZ199'))));

  return (
    <>
      <style>{`
        @page { size: A4; margin: 0; }
        html, body { margin: 0; padding: 0; background: white; }
        #root { height: auto !important; }
      `}</style>
      <div style={styles.page}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Anlage EÜR</div>
            <div style={styles.subtitle}>Einnahmenüberschussrechnung {taxYear}</div>
          </div>
          <div style={styles.headerRight}>
            <div style={styles.headerMeta}>Steuerjahr {taxYear}</div>
            <div style={styles.headerMeta}>
              Zeitraum: {formatDate(report.from)} – {formatDate(report.to)}
            </div>
          </div>
        </div>

        {/* Business Info */}
        <div style={styles.businessInfo}>
          <div style={styles.businessName}>{settings.company.name}</div>
          {settings.company.owner && <div style={styles.businessDetail}>{settings.company.owner}</div>}
          <div style={styles.businessDetail}>
            {settings.company.street}, {settings.company.zip} {settings.company.city}
          </div>
          <div style={styles.businessIds}>
            {settings.finance.taxId && <span>Steuernummer: {settings.finance.taxId}</span>}
            {settings.finance.taxId && settings.finance.vatId && <span style={{ margin: '0 12px' }}>|</span>}
            {settings.finance.vatId && <span>USt-IdNr.: {settings.finance.vatId}</span>}
          </div>
        </div>

        {/* Warnings */}
        {(report.warnings.length > 0 || report.unclassifiedCount > 0) && (
          <div style={styles.warningBox}>
            {report.unclassifiedCount > 0 && (
              <div>Hinweis: {report.unclassifiedCount} Position(en) noch nicht klassifiziert.</div>
            )}
            {report.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        {/* Betriebseinnahmen */}
        <div style={styles.sectionHeader}>Betriebseinnahmen</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.thKz}>Kz</th>
              <th style={styles.thLabel}>Bezeichnung</th>
              <th style={styles.thAmount}>Betrag</th>
            </tr>
          </thead>
          <tbody>
            {incomeRows.map((row) => (
              <tr key={row.lineId} style={row.kind === 'computed' ? styles.computedRow : undefined}>
                <td style={styles.tdKz}>{row.kennziffer ?? ''}</td>
                <td style={styles.tdLabel}>{row.label}</td>
                <td style={styles.tdAmount}>{formatEur(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Betriebsausgaben */}
        <div style={{ ...styles.sectionHeader, marginTop: 20 }}>Betriebsausgaben</div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.thKz}>Kz</th>
              <th style={styles.thLabel}>Bezeichnung</th>
              <th style={styles.thAmount}>Betrag</th>
            </tr>
          </thead>
          <tbody>
            {expenseRows.map((row) => (
              <tr key={row.lineId} style={row.kind === 'computed' ? styles.computedRow : undefined}>
                <td style={styles.tdKz}>{row.kennziffer ?? ''}</td>
                <td style={styles.tdLabel}>{row.label}</td>
                <td style={styles.tdAmount}>{formatEur(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Summary */}
        <div style={styles.summaryBox}>
          <div style={styles.summaryTitle}>Zusammenfassung</div>
          <div style={styles.summaryRow}>
            <span>Summe Betriebseinnahmen (Kz 159)</span>
            <span>{formatEur(report.summary.incomeTotal)}</span>
          </div>
          <div style={styles.summaryRow}>
            <span>Summe Betriebsausgaben (Kz 199)</span>
            <span>{formatEur(report.summary.expenseTotal)}</span>
          </div>
          <div style={styles.summaryDivider} />
          <div style={styles.surplusRow}>
            <span>{report.summary.surplus >= 0 ? 'Überschuss' : 'Fehlbetrag'}</span>
            <span>{formatEur(report.summary.surplus)}</span>
          </div>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          Erstellt am {new Date().toLocaleDateString('de-DE')} — Billme
        </div>
      </div>
    </>
  );
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    fontSize: '9pt',
    color: '#1a1a1a',
    padding: '15mm 18mm',
    background: 'white',
    width: '210mm',
    boxSizing: 'border-box',
    lineHeight: 1.4,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
    paddingBottom: 10,
    borderBottom: '2px solid #1a1a1a',
  },
  title: {
    fontSize: '18pt',
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
  subtitle: {
    fontSize: '10pt',
    color: '#555',
    marginTop: 2,
  },
  headerRight: {
    textAlign: 'right' as const,
  },
  headerMeta: {
    fontSize: '8.5pt',
    color: '#555',
  },
  businessInfo: {
    marginBottom: 14,
    paddingBottom: 10,
    borderBottom: '1px solid #ddd',
  },
  businessName: {
    fontSize: '10pt',
    fontWeight: 600,
  },
  businessDetail: {
    fontSize: '8.5pt',
    color: '#444',
  },
  businessIds: {
    fontSize: '8pt',
    color: '#666',
    marginTop: 3,
  },
  warningBox: {
    background: '#fff8e1',
    border: '1px solid #ffe082',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: '8pt',
    color: '#8d6e00',
    marginBottom: 14,
  },
  sectionHeader: {
    fontSize: '11pt',
    fontWeight: 700,
    color: '#1a1a1a',
    marginBottom: 6,
    paddingBottom: 3,
    borderBottom: '1px solid #ccc',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    marginBottom: 4,
  },
  thKz: {
    width: 50,
    textAlign: 'left' as const,
    fontWeight: 600,
    fontSize: '8pt',
    color: '#666',
    borderBottom: '1px solid #ddd',
    padding: '4px 4px 4px 0',
  },
  thLabel: {
    textAlign: 'left' as const,
    fontWeight: 600,
    fontSize: '8pt',
    color: '#666',
    borderBottom: '1px solid #ddd',
    padding: '4px 4px',
  },
  thAmount: {
    width: 100,
    textAlign: 'right' as const,
    fontWeight: 600,
    fontSize: '8pt',
    color: '#666',
    borderBottom: '1px solid #ddd',
    padding: '4px 0 4px 4px',
  },
  tdKz: {
    textAlign: 'left' as const,
    padding: '3px 4px 3px 0',
    borderBottom: '1px solid #f0f0f0',
    fontSize: '8.5pt',
    color: '#888',
  },
  tdLabel: {
    textAlign: 'left' as const,
    padding: '3px 4px',
    borderBottom: '1px solid #f0f0f0',
  },
  tdAmount: {
    textAlign: 'right' as const,
    padding: '3px 0 3px 4px',
    borderBottom: '1px solid #f0f0f0',
    fontVariantNumeric: 'tabular-nums',
  },
  computedRow: {
    fontWeight: 700,
    background: '#f8f8f8',
  },
  summaryBox: {
    marginTop: 20,
    padding: '12px 14px',
    border: '1.5px solid #1a1a1a',
    borderRadius: 4,
  },
  summaryTitle: {
    fontSize: '10pt',
    fontWeight: 700,
    marginBottom: 8,
  },
  summaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '3px 0',
    fontSize: '9pt',
  },
  summaryDivider: {
    borderTop: '1.5px solid #1a1a1a',
    margin: '6px 0',
  },
  surplusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '3px 0',
    fontSize: '11pt',
    fontWeight: 700,
  },
  footer: {
    marginTop: 24,
    paddingTop: 8,
    borderTop: '1px solid #ddd',
    fontSize: '7.5pt',
    color: '#999',
    textAlign: 'center' as const,
  },
};
