import { LockKeyhole, TriangleAlert } from 'lucide-react';
import type { ReportQuality } from '../../domain/reportTypes';

type ReportStatusBadgeProps = { quality?: Pick<ReportQuality, 'source' | 'state' | 'mappingStatus' | 'unmappedAccounts'> };

export function reportIsMappingBlocked(quality?: Pick<ReportQuality, 'mappingStatus' | 'unmappedAccounts'>): boolean {
  if (!quality) return false;
  if (quality.mappingStatus === 'blocked') return true;
  return Array.isArray(quality.unmappedAccounts)
    ? quality.unmappedAccounts.length > 0
    : Number(quality.unmappedAccounts ?? 0) > 0;
}

export default function ReportStatusBadge({ quality }: ReportStatusBadgeProps) {
  if (!quality) return null;
  const blocked = quality.mappingStatus === 'blocked';
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2 py-1 text-xs font-semibold text-muted">
      {quality.state === 'frozen' ? <LockKeyhole size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
      {quality.state === 'frozen' ? 'Eingefrorener Abschluss' : 'Vorschau'}
      {blocked ? ' · Mapping prüfen' : quality.source === 'live' ? ' · Live-Daten' : ' · Beispieldaten'}
    </span>
  );
}

export function MappingHealthBlock({ quality }: ReportStatusBadgeProps & { notes?: string[] }) {
  if (!reportIsMappingBlocked(quality)) return null;
  return (
    <div className="rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error" role="alert">
      <div className="font-bold">Auswertung blockiert: Konten-Mapping unvollständig</div>
      <p className="mt-1">Bitte ordnen Sie alle betroffenen Konten zu, bevor Sie diesen Report als Abschluss verwenden oder exportieren.</p>
      {quality?.mappingStatus === 'blocked' ? <p className="mt-1 text-xs">Mapping-Health: blockierend.</p> : null}
      {Array.isArray(quality?.unmappedAccounts) && quality.unmappedAccounts.length > 0 ? (
        <p className="mt-1 text-xs">Betroffene Konten: {quality.unmappedAccounts.map((account) => account.accountNumber).join(', ')}</p>
      ) : null}
    </div>
  );
}
