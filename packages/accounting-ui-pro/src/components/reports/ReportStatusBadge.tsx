import { LockKeyhole, TriangleAlert } from 'lucide-react';
import { Badge } from '@billme/ui';
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
    <Badge tone="neutral">
      {quality.state === 'frozen' ? <LockKeyhole size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
      {`${quality.state === 'frozen' ? 'Eingefrorener Abschluss' : 'Vorschau'}${blocked ? ' · Mapping prüfen' : quality.source === 'live' ? ' · Live-Daten' : ' · Beispieldaten'}`}
    </Badge>
  );
}

export function MappingHealthBlock({ quality }: ReportStatusBadgeProps & { notes?: string[] }) {
  if (!reportIsMappingBlocked(quality)) return null;
  return (
    <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">
      <div className="font-semibold">Auswertung blockiert: Konten-Mapping unvollständig</div>
      <p className="mt-1">Bitte ordnen Sie alle betroffenen Konten zu, bevor Sie diesen Report als Abschluss verwenden oder exportieren.</p>
      {quality?.mappingStatus === 'blocked' ? <p className="mt-1 text-caption">Mapping-Health: blockierend.</p> : null}
      {Array.isArray(quality?.unmappedAccounts) && quality.unmappedAccounts.length > 0 ? (
        <p className="mt-1 text-caption">Betroffene Konten: {quality.unmappedAccounts.map((account) => account.accountNumber).join(', ')}</p>
      ) : null}
    </div>
  );
}
