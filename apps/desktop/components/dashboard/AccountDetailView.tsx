import React, { useState } from 'react';
import {
  ArrowLeft, ArrowDownLeft, ArrowUpRight, Link, X, Search, FileText, Inbox,
} from 'lucide-react';
import type { QueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { formatCurrency } from './helpers';
import { Account, Invoice } from '../../types';

type ImportProfile = 'auto' | 'fints' | 'paypal' | 'stripe' | 'generic';
type ImportMapping = {
  dateColumn: string;
  amountColumn: string;
  counterpartyColumn?: string;
  purposeColumn?: string;
  statusColumn?: string;
  externalIdColumn?: string;
  currencyColumn?: string;
  currencyExpected?: string;
};

const ROWS_PER_PAGE = 100;

interface AccountDetailViewProps {
  selectedAccount: Account;
  invoices: Invoice[];
  onBack: () => void;
  onUpsertAccount: (account: Account) => void;
  queryClient: QueryClient;
}

export const AccountDetailView: React.FC<AccountDetailViewProps> = ({
  selectedAccount,
  invoices,
  onBack,
  onUpsertAccount,
  queryClient,
}) => {
  const [linkingTransactionId, setLinkingTransactionId] = useState<string | null>(null);
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
  const [invoiceSearch, setInvoiceSearch] = useState('');

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importProfile, setImportProfile] = useState<ImportProfile>('auto');
  const [importMapping, setImportMapping] = useState<ImportMapping | null>(null);
  const [importEncoding, setImportEncoding] = useState<'utf8' | 'win1252'>('utf8');
  const [importDelimiter, setImportDelimiter] = useState<string>('');
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: number } | null>(null);
  const [importPreviewPage, setImportPreviewPage] = useState(0);
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);
  const [isImportBusy, setIsImportBusy] = useState(false);

  const closeImport = () => {
    setIsImportOpen(false);
    setImportPath(null);
    setImportProfile('auto');
    setImportMapping(null);
    setImportDelimiter('');
    setImportPreview(null);
    setImportError(null);
    setImportResult(null);
    setIsImportBusy(false);
  };

  const refreshImportPreview = async (opts?: { path?: string; profile?: ImportProfile; mapping?: ImportMapping | null }) => {
    const filePath = opts?.path ?? importPath;
    if (!filePath) return;
    const profile = opts?.profile ?? importProfile;
    const mapping = opts?.mapping ?? importMapping;
    setImportError(null);
    setIsImportBusy(true);
    try {
      const res = await ipc.finance.importPreview({
        path: filePath,
        profile,
        mapping: mapping ?? undefined,
        encoding: importEncoding,
        delimiter: importDelimiter || undefined,
        maxRows: 50,
        accountIdForDedupHash: selectedAccount.id,
      });
      setImportPreview(res);
      setImportMapping(mapping ?? res.suggestedMapping);
    } catch (e) {
      setImportError(String(e));
    } finally {
      setIsImportBusy(false);
    }
  };

  const openImportWithPicker = async () => {
    setImportResult(null);
    const res = await ipc.dialog.pickCsv({ title: 'CSV importieren' });
    if (!res.path) return;
    setIsImportOpen(true);
    setImportPath(res.path);
    setImportProfile('auto');
    setImportMapping(null);
    setImportDelimiter('');
    setImportPreview(null);
    setImportError(null);
    await refreshImportPreview({ path: res.path, profile: 'auto', mapping: null });
  };

  const commitImport = async () => {
    if (!importPath || !importMapping) return;
    setIsImportBusy(true);
    setImportError(null);
    try {
      const res = await ipc.finance.importCommit({
        path: importPath,
        accountId: selectedAccount.id,
        profile: importProfile,
        mapping: importMapping,
        encoding: importEncoding,
        delimiter: importDelimiter || undefined,
      });
      setImportResult({ imported: res.imported, skipped: res.skipped, errors: res.errors.length });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      setImportError(String(e));
    } finally {
      setIsImportBusy(false);
    }
  };

  const handleLinkClick = (transactionId: string) => {
    setLinkingTransactionId(transactionId);
    setIsLinkModalOpen(true);
  };

  const handleConfirmLink = (invoiceId: string) => {
    if (!linkingTransactionId) return;
    onUpsertAccount({
      ...selectedAccount,
      transactions: selectedAccount.transactions.map(t =>
        t.id === linkingTransactionId
        ? { ...t, linkedInvoiceId: invoiceId }
        : t
      ),
    });
    setIsLinkModalOpen(false);
    setLinkingTransactionId(null);
  };

  const filteredInvoices = invoices.filter(inv =>
    (inv.status === 'open' || inv.status === 'overdue') &&
    (inv.number.toLowerCase().includes(invoiceSearch.toLowerCase()) ||
     inv.client.toLowerCase().includes(invoiceSearch.toLowerCase()))
  );

  return (
    <div className="bg-surface rounded-xl shadow-sm overflow-hidden p-8 min-h-full flex flex-col relative animate-enter">

      {/* CSV Import Modal */}
      {isImportOpen && (
        <div className="absolute inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4 rounded-2xl animate-fade-in">
          <div className="bg-surface rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[85vh] animate-scale-in">
            <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-surface-muted">
              <div>
                <h3 className="font-bold text-lg">CSV Import</h3>
                <p className="text-xs text-muted mt-1">Konto: {selectedAccount.name}</p>
              </div>
              <button onClick={closeImport} className="p-2 hover:bg-canvas rounded-full transition-colors"><X size={18} /></button>
            </div>

            <div className="p-6 overflow-y-auto">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex-1 min-w-[260px]">
                  <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Datei</label>
                  <div className="flex gap-2">
                    <input
                      value={importPath ?? ''}
                      readOnly
                      className="flex-1 bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-mono"
                    />
                    <button
                      disabled={isImportBusy}
                      onClick={openImportWithPicker}
                      className="px-4 py-2 rounded-lg font-bold bg-surface border border-border hover:bg-surface-muted transition-colors text-sm"
                    >
                      Ändern
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Profil</label>
                  <select
                    value={importProfile}
                    onChange={async (e) => {
                      const p = e.target.value as ImportProfile;
                      setImportProfile(p);
                      setImportMapping(null);
                      await refreshImportPreview({ profile: p, mapping: null });
                    }}
                    className="bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-bold"
                  >
                    <option value="auto">Auto</option>
                    <option value="fints">FinTS</option>
                    <option value="paypal">PayPal</option>
                    <option value="stripe">Stripe</option>
                    <option value="generic">Generic</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Encoding</label>
                  <select
                    value={importEncoding}
                    onChange={async (e) => {
                      const enc = e.target.value as 'utf8' | 'win1252';
                      setImportEncoding(enc);
                      await refreshImportPreview({});
                    }}
                    className="bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-bold"
                  >
                    <option value="utf8">UTF-8</option>
                    <option value="win1252">Windows-1252</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Delimiter</label>
                  <input
                    value={importDelimiter}
                    onChange={(e) => setImportDelimiter(e.target.value)}
                    placeholder="(auto)"
                    className="w-28 bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>

                <button
                  disabled={isImportBusy || !importPath}
                  onClick={() => refreshImportPreview({})}
                  className="px-4 py-2 rounded-xl font-bold bg-black text-white hover:bg-dark-2 transition-colors ease-out text-sm"
                >
                  Vorschau
                </button>
              </div>

              {importPreview && importMapping && (
                <>
                  <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Datum</label>
                      <select
                        value={importMapping.dateColumn}
                        onChange={(e) => setImportMapping({ ...importMapping, dateColumn: e.target.value })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-bold"
                      >
                        {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Betrag</label>
                      <select
                        value={importMapping.amountColumn}
                        onChange={(e) => setImportMapping({ ...importMapping, amountColumn: e.target.value })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-bold"
                      >
                        {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Gegenpartei</label>
                      <select
                        value={importMapping.counterpartyColumn ?? ''}
                        onChange={(e) => setImportMapping({ ...importMapping, counterpartyColumn: e.target.value || undefined })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-bold"
                      >
                        <option value="">(leer)</option>
                        {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Zweck</label>
                      <select
                        value={importMapping.purposeColumn ?? ''}
                        onChange={(e) => setImportMapping({ ...importMapping, purposeColumn: e.target.value || undefined })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-sm font-bold"
                      >
                        <option value="">(leer)</option>
                        {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  </div>

                  <div className="mt-6 flex items-center justify-between">
                    <div className="text-sm text-muted tabular-nums">
                      <span className="font-bold">{importPreview.stats.validRows}</span> ok ·{' '}
                      <span className="font-bold">{importPreview.stats.errorRows}</span> Fehler ·{' '}
                      <span className="font-bold">{importPreview.stats.totalRows}</span> Zeilen
                    </div>
                    <button
                      disabled={isImportBusy || !importMapping}
                      onClick={commitImport}
                      className="px-5 py-3 rounded-xl font-bold bg-accent text-black hover:bg-accent-hover transition-colors ease-out"
                    >
                      Import starten
                    </button>
                  </div>

                  {importError && (
                    <div className="mt-4 p-4 rounded-xl border border-error-border bg-error-bg text-error font-mono text-xs">
                      {importError}
                    </div>
                  )}

                  {importResult && (
                    <div className="mt-4 p-4 rounded-xl border border-success-border bg-success-bg text-success text-sm">
                      <div className="font-bold mb-1">Import abgeschlossen</div>
                      <div>Importiert: <span className="font-bold">{importResult.imported}</span></div>
                      <div>Übersprungen (Duplikate): <span className="font-bold">{importResult.skipped}</span></div>
                      <div>Fehler: <span className="font-bold">{importResult.errors}</span></div>
                    </div>
                  )}

                  <div className="mt-6">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-bold text-xs uppercase text-muted">Vorschau</h4>
                      {importPreview.stats.errorRows > 0 && (
                        <button
                          onClick={() => setShowOnlyErrors(!showOnlyErrors)}
                          className="px-3 py-1 rounded-lg bg-canvas hover:bg-border text-xs font-bold transition-colors ease-out"
                        >
                          {showOnlyErrors ? 'Alle zeigen' : 'Nur Fehler'}
                        </button>
                      )}
                    </div>
                    <div className="border border-border-subtle rounded-xl overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-surface-muted">
                          <tr className="text-left text-[10px] uppercase tracking-wider text-muted">
                            <th className="px-4 py-3">Datum</th>
                            <th className="px-4 py-3">Betrag</th>
                            <th className="px-4 py-3">Gegenpartei</th>
                            <th className="px-4 py-3">Zweck</th>
                            <th className="px-4 py-3">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const filteredRows = showOnlyErrors
                              ? importPreview.rows.filter((r: any) => r.errors.length > 0)
                              : importPreview.rows;
                            const startIndex = importPreviewPage * ROWS_PER_PAGE;
                            const paginatedRows = filteredRows.slice(startIndex, startIndex + ROWS_PER_PAGE);
                            return paginatedRows.map((r: any) => (
                            <tr key={r.rowIndex} className={`border-t ${r.errors.length ? 'bg-error-bg/40' : ''}`}>
                              <td className="px-4 py-3 font-mono text-xs">{r.parsed.date ?? '-'}</td>
                              <td className="px-4 py-3 tabular-nums text-xs">{typeof r.parsed.amount === 'number' ? formatCurrency(r.parsed.amount) : '-'}</td>
                              <td className="px-4 py-3">{r.parsed.counterparty ?? ''}</td>
                              <td className="px-4 py-3 text-muted">{r.parsed.purpose ?? ''}</td>
                              <td className="px-4 py-3">
                                {r.errors.length ? (
                                  <span className="text-[10px] font-bold px-2 py-1 rounded bg-error-bg text-error">Fehler</span>
                                ) : (
                                  <span className="text-[10px] font-bold px-2 py-1 rounded bg-success-bg text-success">OK</span>
                                )}
                              </td>
                            </tr>
                          ));
                          })()}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination Controls */}
                    {(() => {
                      const filteredRows = showOnlyErrors
                        ? importPreview.rows.filter((r: any) => r.errors.length > 0)
                        : importPreview.rows;
                      const totalPages = Math.ceil(filteredRows.length / ROWS_PER_PAGE);

                      if (totalPages <= 1) return null;

                      return (
                        <div className="mt-3 flex items-center justify-between text-sm">
                          <div className="text-muted tabular-nums">
                            Seite {importPreviewPage + 1} von {totalPages} ({filteredRows.length} Zeilen)
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setImportPreviewPage(Math.max(0, importPreviewPage - 1))}
                              disabled={importPreviewPage === 0}
                              className="px-3 py-1 rounded-lg bg-canvas hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-colors ease-out"
                            >
                              Zurück
                            </button>
                            <button
                              onClick={() => setImportPreviewPage(Math.min(totalPages - 1, importPreviewPage + 1))}
                              disabled={importPreviewPage >= totalPages - 1}
                              className="px-3 py-1 rounded-lg bg-canvas hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-colors ease-out"
                            >
                              Weiter
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Linking Modal */}
      {isLinkModalOpen && (
          <div className="absolute inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4 rounded-2xl animate-fade-in">
              <div className="bg-surface rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[600px] animate-scale-in">
                  <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-surface-muted">
                      <h3 className="font-bold text-lg flex items-center gap-2">
                          <Link size={18} />
                          Transaktion zuweisen
                      </h3>
                      <button onClick={() => setIsLinkModalOpen(false)} className="p-2 hover:bg-canvas rounded-full transition-colors ease-out"><X size={18} /></button>
                  </div>

                  <div className="p-4 border-b border-border-subtle">
                      <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
                          <input
                              type="text"
                              placeholder="Rechnung oder Kunde suchen..."
                              value={invoiceSearch}
                              onChange={(e) => setInvoiceSearch(e.target.value)}
                              className="w-full bg-surface-muted border border-border rounded-lg pl-10 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                          />
                      </div>
                  </div>

                  <div className="overflow-y-auto p-4 space-y-2">
                      {filteredInvoices.length > 0 ? filteredInvoices.map(inv => (
                          <div
                              key={inv.id}
                              onClick={() => handleConfirmLink(inv.id)}
                              className="p-4 rounded-xl border border-border hover:border-foreground hover:bg-surface-muted cursor-pointer transition-[background-color,border-color,color,box-shadow,opacity,transform,width] group"
                          >
                              <div className="flex justify-between items-center mb-1">
                                  <span className="font-bold text-sm">{inv.number}</span>
                                  <span className="tabular-nums font-bold text-sm">{formatCurrency(inv.amount)}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                  <span className="text-xs text-muted">{inv.client}</span>
                                  <span className={`text-[10px] font-bold px-2 py-1 rounded ${inv.status === 'overdue' ? 'bg-error-bg text-error' : 'bg-success-bg text-success'}`}>
                                      {inv.status.toUpperCase()}
                                  </span>
                              </div>
                          </div>
                      )) : (
                          <div className="text-center py-8 text-muted">
                              <FileText size={32} className="mx-auto mb-2 opacity-30" />
                              <p className="text-sm">Keine offenen Rechnungen gefunden.</p>
                          </div>
                      )}
                  </div>
              </div>
          </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-8 pb-8 border-b border-border-subtle">
          <div className="flex items-center gap-4">
              <button
                  onClick={onBack}
                  className="w-10 h-10 rounded-full border border-border flex items-center justify-center hover:bg-foreground hover:text-surface transition-colors ease-out"
              >
                  <ArrowLeft size={18} />
              </button>
              <div>
                  <h3 className="font-bold text-2xl text-foreground">{selectedAccount.name}</h3>
                  <p className="text-muted font-mono text-sm">{selectedAccount.iban}</p>
              </div>
          </div>
          <div className="flex items-end gap-3">
              <button
                onClick={openImportWithPicker}
                className="h-10 px-4 bg-black text-white rounded-full text-xs font-bold hover:bg-dark-2 transition-colors ease-out flex items-center gap-2"
              >
                CSV importieren
              </button>
              <div className="text-right">
                  <p className="text-xs font-bold text-muted uppercase tracking-wide">Aktueller Saldo</p>
                  <p className="text-4xl tabular-nums font-bold">{formatCurrency(selectedAccount.balance)}</p>
              </div>
          </div>
      </div>

      {/* Transactions List */}
      <div className="flex-1 overflow-y-auto">
          <h4 className="font-bold text-sm mb-4 uppercase text-muted">Buchungen</h4>
          <div className="space-y-3">
              {selectedAccount.transactions.map((tx, i) => {
                  const linkedInvoice = tx.linkedInvoiceId
                      ? invoices.find(inv => inv.id === tx.linkedInvoiceId)
                      : null;

                  return (
                      <div
                          key={tx.id}
                          className="group flex items-center justify-between p-4 rounded-xl border border-border-subtle hover:border-border hover:shadow-md transition-[background-color,border-color,color,box-shadow,opacity,transform,width] bg-surface animate-enter"
                          style={{ animationDelay: `${i * 50}ms` }}
                      >
                          <div className="flex items-center gap-4">
                              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${tx.type === 'income' ? 'bg-accent/20 text-black' : 'bg-surface-muted text-muted'}`}>
                                  {tx.type === 'income' ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}
                              </div>
                              <div>
                                  <p className="font-bold text-foreground">{tx.counterparty}</p>
                                  <div className="flex items-center gap-2">
                                      <span className="text-xs text-muted font-mono">{new Date(tx.date).toLocaleDateString()}</span>
                                      <span className="text-xs text-muted line-clamp-1 max-w-[200px]">{tx.purpose}</span>
                                  </div>
                              </div>
                          </div>

                          <div className="flex items-center gap-6">
                              {/* Status / Actions */}
                              <div className="flex flex-col items-end gap-1">
                                  <p className={`tabular-nums font-bold text-lg ${tx.type === 'income' ? 'text-success' : 'text-foreground'}`}>
                                      {tx.type === 'income' ? '+' : ''}{formatCurrency(tx.amount)}
                                  </p>

                                  {linkedInvoice ? (
                                      <div className="flex items-center gap-1.5 bg-success-bg text-success px-2 py-1 rounded text-[10px] font-bold border border-success-border">
                                          <Link size={10} />
                                          <span>{linkedInvoice.number}</span>
                                      </div>
                                  ) : (
                                      tx.type === 'income' && (
                                          <button
                                              onClick={() => handleLinkClick(tx.id)}
                                              className="flex items-center gap-1.5 bg-black text-accent px-3 py-1 rounded text-[10px] font-bold hover:bg-dark-2 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-150 ease-out opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0"
                                          >
                                              <Link size={10} />
                                              Zuweisen
                                          </button>
                                      )
                                  )}
                              </div>
                          </div>
                      </div>
                  );
              })}
              {selectedAccount.transactions.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
                      <Inbox size={36} className="text-muted opacity-40" />
                      <p className="text-sm font-bold text-foreground">Keine Buchungen vorhanden</p>
                      <p className="text-xs text-muted">Importieren Sie Transaktionen per CSV oder erfassen Sie diese manuell.</p>
                  </div>
              )}
          </div>
      </div>
    </div>
  );
};
