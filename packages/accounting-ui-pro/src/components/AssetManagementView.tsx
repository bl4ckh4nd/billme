import { useEffect, useMemo, useState } from 'react';
import { Building2, Search } from 'lucide-react';
import type { AssetDepreciationScheduleEntry, AssetItem, AssetStatus } from '../domain/assetTypes';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';

const mockAssets: AssetItem[] = [
  {
    id: 'a1',
    assetNumber: 'ANL-2026-001',
    name: 'MacBook Pro 16" Buchhaltung',
    assetClass: 'IT-Hardware',
    status: 'aktiv',
    activationDate: '2026-01-15',
    acquisitionCost: 2899,
    residualValue: 2415.83,
    annualDepreciation: 966.33,
    depreciationMethod: 'linear',
    costCenter: 'FIN-01',
    location: 'Berlin HQ',
    nextDepreciation: '2026-03-31',
    receiptLinked: true,
    assetAccountNumber: '0440',
    supplier: 'Apple Retail DE',
    invoiceRef: 'RE-IT-1548',
  },
  {
    id: 'a2',
    assetNumber: 'ANL-2025-014',
    name: 'Lagerregal Schwerlastsystem',
    assetClass: 'Betriebsausstattung',
    status: 'aktiv',
    activationDate: '2025-08-01',
    acquisitionCost: 4200,
    residualValue: 3500,
    annualDepreciation: 840,
    depreciationMethod: 'linear',
    costCenter: 'OPS-02',
    location: 'Lager Süd',
    nextDepreciation: '2026-03-31',
    receiptLinked: true,
    assetAccountNumber: '0480',
  },
  {
    id: 'a3',
    assetNumber: 'ANL-2024-007',
    name: 'Transporter Ford Transit',
    assetClass: 'Fuhrpark',
    status: 'aktiv',
    activationDate: '2024-04-01',
    acquisitionCost: 34900,
    residualValue: 23266.67,
    annualDepreciation: 5816.67,
    depreciationMethod: 'linear',
    costCenter: 'LOG-01',
    location: 'Hamburg',
    nextDepreciation: '2026-03-31',
    receiptLinked: true,
    assetAccountNumber: '0670',
  },
  {
    id: 'a4',
    assetNumber: 'ANL-2022-003',
    name: 'Drucker Empfang',
    assetClass: 'Bürogeräte',
    status: 'voll_abgeschrieben',
    activationDate: '2022-01-10',
    acquisitionCost: 799,
    residualValue: 0,
    annualDepreciation: 266.33,
    depreciationMethod: 'gwg',
    costCenter: 'ADM-01',
    location: 'Berlin HQ',
    nextDepreciation: '—',
    receiptLinked: true,
    assetAccountNumber: '0490',
  },
  {
    id: 'a5',
    assetNumber: 'ANL-2026-009',
    name: '3D-Drucker Prototyping',
    assetClass: 'Maschinen',
    status: 'entwurf',
    activationDate: '2026-02-20',
    acquisitionCost: 9800,
    residualValue: 9800,
    annualDepreciation: 1960,
    depreciationMethod: 'linear',
    costCenter: 'RND-01',
    location: 'München Lab',
    nextDepreciation: 'Nicht aktiviert',
    receiptLinked: false,
    assetAccountNumber: '0400',
    supplier: 'TechTools GmbH',
    invoiceRef: 'TT-7742',
  },
];

const tabs = ['Übersicht', 'Stammdaten', 'Abschreibungsplan', 'Bewegungen', 'Buchungen', 'Belege', 'Historie'] as const;

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

function statusPill(status: AssetStatus) {
  const map: Record<AssetStatus, { label: string; className: string }> = {
    entwurf: { label: 'Entwurf', className: 'bg-amber-100 text-amber-700' },
    aktiv: { label: 'Aktiv', className: 'bg-emerald-100 text-emerald-700' },
    voll_abgeschrieben: { label: 'Voll abgeschrieben', className: 'bg-gray-100 text-gray-700' },
    verkauft: { label: 'Verkauft', className: 'bg-blue-100 text-blue-700' },
    stillgelegt: { label: 'Stillgelegt', className: 'bg-rose-100 text-rose-700' },
  };
  return map[status];
}

export default function AssetManagementView({ dataAdapter }: { dataAdapter?: ProAccountingDataAdapter }) {
  const [assets, setAssets] = useState<AssetItem[]>(() => (dataAdapter ? [] : mockAssets));
  const [schedule, setSchedule] = useState<AssetDepreciationScheduleEntry[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'alle' | AssetStatus>('alle');
  const [selectedId, setSelectedId] = useState<string>(mockAssets[0]?.id ?? '');
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('Übersicht');

  useEffect(() => {
    if (!dataAdapter) {
      setAssets(mockAssets);
      setAssetsError(null);
      return;
    }
    const list = dataAdapter.listAssets;
    if (!list) {
      setAssets([]);
      setAssetsError('Anlagen konnten nicht geladen werden.');
      return;
    }
    setAssetsError(null);
    void list().then(setAssets).catch((error) => {
      setAssets([]);
      setAssetsError(error instanceof Error ? error.message : 'Anlagen konnten nicht geladen werden.');
    });
  }, [dataAdapter]);

  const filtered = useMemo(() => {
    return assets.filter((asset) => {
      const matchesStatus = statusFilter === 'alle' || asset.status === statusFilter;
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        [asset.assetNumber, asset.name, asset.assetClass, asset.costCenter, asset.location]
          .join(' ')
          .toLowerCase()
          .includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [assets, query, statusFilter]);

  const selected = filtered.find((asset) => asset.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    const load = dataAdapter?.getDepreciationSchedule;
    if (!load || !selected) {
      setSchedule([]);
      return;
    }
    void load(selected.id).then(setSchedule).catch(() => setSchedule([]));
  }, [dataAdapter, selected?.id]);

  const totals = useMemo(() => {
    const active = assets.filter((a) => a.status === 'aktiv');
    return {
      totalAssets: assets.length,
      activeAssets: active.length,
      totalAcquisition: assets.reduce((sum, a) => sum + a.acquisitionCost, 0),
      totalResidual: assets.reduce((sum, a) => sum + a.residualValue, 0),
    };
  }, [assets]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden xl:flex-row">
      <div className="flex min-h-0 flex-col border-b border-gray-100 xl:w-96 xl:min-w-96 xl:max-w-96 xl:border-b-0 xl:border-r">
        <div className="px-4 py-3 border-b border-gray-100 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-black text-accent flex items-center justify-center shrink-0">
              <Building2 size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-black tracking-tight text-gray-900 leading-tight">Anlagenverwaltung</h1>
              <p className="text-xs text-gray-400 font-medium leading-tight">
                Übersicht, Aktivierung und Abschreibung.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">Anlagen gesamt</div>
              <div className="text-sm font-bold text-gray-900 mt-0.5">{totals.totalAssets} <span className="text-xs font-medium text-gray-500">({totals.activeAssets} aktiv)</span></div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">Restbuchwert</div>
              <div className="text-sm font-bold text-gray-900 mt-0.5">{euro(totals.totalResidual)} <span className="text-xs font-medium text-gray-500">AK {euro(totals.totalAcquisition)}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={13} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Anlage suchen (Nr., Name, Klasse, KSt.)"
                className="w-full h-8 rounded-lg border border-gray-200 pl-8 pr-3 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'alle' | AssetStatus)}
                className="h-8 rounded-lg border border-gray-200 px-2 text-xs font-medium"
              >
                <option value="alle">Alle Status</option>
                <option value="entwurf">Entwurf</option>
                <option value="aktiv">Aktiv</option>
                <option value="voll_abgeschrieben">Voll abgeschrieben</option>
                <option value="verkauft">Verkauft</option>
                <option value="stillgelegt">Stillgelegt</option>
              </select>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-2">
          {filtered.map((asset) => {
            const pill = statusPill(asset.status);
            const selectedCard = selected?.id === asset.id;
            return (
              <button
                key={asset.id}
                onClick={() => setSelectedId(asset.id)}
                className={`w-full text-left rounded-xl border p-4 transition-colors ${
                  selectedCard ? 'border-black bg-gray-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-400 font-bold">{asset.assetNumber}</div>
                    <div className="font-bold text-gray-900 truncate">{asset.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {asset.assetClass} • {asset.costCenter} • {asset.location}
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-[11px] font-bold whitespace-nowrap ${pill.className}`}>
                    {pill.label}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-gray-400 font-bold uppercase tracking-wide">AK</div>
                    <div className="text-gray-700 font-bold">{euro(asset.acquisitionCost)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 font-bold uppercase tracking-wide">RBW</div>
                    <div className="text-gray-700 font-bold">{euro(asset.residualValue)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 font-bold uppercase tracking-wide">Nächste AfA</div>
                    <div className="text-gray-700 font-bold">{asset.nextDepreciation}</div>
                  </div>
                </div>
              </button>
            );
          })}
          {assetsError && <div className="rounded-xl border border-error-border bg-error-bg p-4 text-sm text-error" role="alert" aria-live="assertive">{assetsError}</div>}
          {filtered.length === 0 && !assetsError && (
            <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
              Keine Anlagen gefunden.
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 min-w-0 flex-col">
        {!selected ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-12 text-gray-500">Keine Anlage ausgewählt.</div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-gray-100 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-gray-400">{selected.assetNumber}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusPill(selected.status).className}`}>
                      {statusPill(selected.status).label}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${selected.receiptLinked ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                      {selected.receiptLinked ? 'Beleg verknüpft' : 'Beleg fehlt'}
                    </span>
                  </div>
                  <h2 className="text-base font-black text-gray-900 tracking-tight mt-0.5">{selected.name}</h2>
                  <p className="text-xs text-gray-400 font-medium">
                    {selected.assetClass} • {selected.costCenter} • {selected.location}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
                <div className="rounded-lg border border-gray-200 px-3 py-2 bg-white">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">AK</div>
                  <div className="text-sm font-bold text-gray-900 mt-0.5">{euro(selected.acquisitionCost)}</div>
                </div>
                <div className="rounded-lg border border-gray-200 px-3 py-2 bg-white">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">RBW</div>
                  <div className="text-sm font-bold text-gray-900 mt-0.5">{euro(selected.residualValue)}</div>
                </div>
                <div className="rounded-lg border border-gray-200 px-3 py-2 bg-white">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">AfA p.a.</div>
                  <div className="text-sm font-bold text-gray-900 mt-0.5">{euro(selected.annualDepreciation)}</div>
                </div>
                <div className="rounded-lg border border-gray-200 px-3 py-2 bg-white">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">Nächste AfA</div>
                  <div className="text-sm font-bold text-gray-900 mt-0.5">{selected.nextDepreciation}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`h-7 px-3 rounded-full text-xs font-bold border ${
                      activeTab === tab
                        ? 'bg-black text-white border-black'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
              <section className="min-w-0 space-y-4">
                <div className="rounded-2xl border border-gray-200 bg-white p-5">
                  <div className="text-sm font-bold text-gray-900 mb-3">{activeTab}</div>

                  {activeTab === 'Übersicht' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div className="space-y-2">
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Lieferant</span><span className="font-bold text-gray-800">{selected.supplier ?? '—'}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Rechnung</span><span className="font-bold text-gray-800">{selected.invoiceRef ?? '—'}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Aktivierung</span><span className="font-bold text-gray-800">{selected.activationDate}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Kostenstelle</span><span className="font-bold text-gray-800">{selected.costCenter}</span></div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Standort</span><span className="font-bold text-gray-800">{selected.location}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Status</span><span className="font-bold text-gray-800">{statusPill(selected.status).label}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Beleg</span><span className="font-bold text-gray-800">{selected.receiptLinked ? 'Verknüpft' : 'Offen'}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-gray-500">Nächste AfA</span><span className="font-bold text-gray-800">{selected.nextDepreciation}</span></div>
                      </div>
                    </div>
                  )}

                  {activeTab === 'Abschreibungsplan' && (
                    <div className="space-y-3">
                      {(schedule.length ? schedule : dataAdapter ? [] : [{
                        id: 'fallback',
                        assetId: selected.id,
                        year: Number(selected.activationDate.slice(0, 4)),
                        amount: selected.annualDepreciation,
                        months: 12,
                        status: 'planned' as const,
                      }]).map((period, index, rows) => {
                        const depreciated = rows.slice(0, index + 1).reduce((sum, row) => sum + row.amount, 0);
                        return (
                        <div key={period.id} className="grid grid-cols-4 gap-3 rounded-lg border border-gray-100 p-3 text-sm">
                          <div><div className="text-xs text-gray-400 font-bold">Jahr</div><div className="font-bold text-gray-800">{period.year}</div></div>
                          <div><div className="text-xs text-gray-400 font-bold">AfA</div><div className="font-bold text-gray-800">{euro(period.amount)}</div></div>
                          <div><div className="text-xs text-gray-400 font-bold">Status</div><div className="font-bold text-gray-800">{period.status === 'posted' ? 'Gebucht' : 'Geplant'}</div></div>
                          <div><div className="text-xs text-gray-400 font-bold">RBW danach</div><div className="font-bold text-gray-800">{euro(Math.max(selected.acquisitionCost - depreciated, 0))}</div></div>
                        </div>
                      );})}
                    </div>
                  )}

                  {activeTab === 'Bewegungen' && (
                    <div className="space-y-3">
                      {!schedule.length && dataAdapter ? <div className="text-sm text-gray-500">Kein Abschreibungsplan vorhanden.</div> : null}
                      <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
                        <div className="font-bold text-gray-900">Zugang / Aktivierung</div>
                        <div className="text-sm text-gray-600 mt-1">
                          {selected.activationDate} • Anschaffung {euro(selected.acquisitionCost)} • Status {statusPill(selected.status).label}
                        </div>
                      </div>
                    </div>
                  )}

                  {!['Übersicht', 'Abschreibungsplan', 'Bewegungen'].includes(activeTab) && (
                    <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-500">
                      Für diesen Bereich liegen noch keine Daten vor.
                    </div>
                  )}
                </div>
              </section>

            </div>
          </>
        )}
      </div>
    </div>
  );
}
