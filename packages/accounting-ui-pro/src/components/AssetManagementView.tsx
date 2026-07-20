import { useMemo, useState } from 'react';
import {
  Archive,
  ArrowRightLeft,
  Building2,
  CalendarClock,
  FileText,
  Filter,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';

type AssetStatus = 'entwurf' | 'aktiv' | 'voll_abgeschrieben' | 'verkauft' | 'stillgelegt';

interface AssetItem {
  id: string;
  assetNumber: string;
  name: string;
  assetClass: string;
  status: AssetStatus;
  activationDate: string;
  acquisitionCost: number;
  residualValue: number;
  annualDepreciation: number;
  costCenter: string;
  location: string;
  nextDepreciation: string;
  receiptLinked: boolean;
  supplier?: string;
  invoiceRef?: string;
}

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
    costCenter: 'FIN-01',
    location: 'Berlin HQ',
    nextDepreciation: '2026-03-31',
    receiptLinked: true,
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
    costCenter: 'OPS-02',
    location: 'Lager Süd',
    nextDepreciation: '2026-03-31',
    receiptLinked: true,
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
    costCenter: 'LOG-01',
    location: 'Hamburg',
    nextDepreciation: '2026-03-31',
    receiptLinked: true,
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
    costCenter: 'ADM-01',
    location: 'Berlin HQ',
    nextDepreciation: '—',
    receiptLinked: true,
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
    costCenter: 'RND-01',
    location: 'München Lab',
    nextDepreciation: 'Nicht aktiviert',
    receiptLinked: false,
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
    entwurf: { label: 'Entwurf', className: 'bg-warning-bg text-warning' },
    aktiv: { label: 'Aktiv', className: 'bg-success-bg text-success' },
    voll_abgeschrieben: { label: 'Voll abgeschrieben', className: 'bg-canvas text-muted' },
    verkauft: { label: 'Verkauft', className: 'bg-info-bg text-info' },
    stillgelegt: { label: 'Stillgelegt', className: 'bg-rose-100 text-rose-700' },
  };
  return map[status];
}

export default function AssetManagementView() {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'alle' | AssetStatus>('alle');
  const [selectedId, setSelectedId] = useState<string>(mockAssets[0]?.id ?? '');
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('Übersicht');

  const filtered = useMemo(() => {
    return mockAssets.filter((asset) => {
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
  }, [query, statusFilter]);

  const selected = filtered.find((asset) => asset.id === selectedId) ?? filtered[0] ?? null;

  const totals = useMemo(() => {
    const active = mockAssets.filter((a) => a.status === 'aktiv');
    return {
      totalAssets: mockAssets.length,
      activeAssets: active.length,
      totalAcquisition: mockAssets.reduce((sum, a) => sum + a.acquisitionCost, 0),
      totalResidual: mockAssets.reduce((sum, a) => sum + a.residualValue, 0),
    };
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden xl:flex-row">
      <div className="flex min-h-0 flex-col border-b border-border-subtle xl:basis-[34rem] xl:min-w-[24rem] xl:max-w-[34rem] xl:border-b-0 xl:border-r">
        <div className="px-4 py-3 border-b border-border-subtle space-y-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-foreground text-accent-lime flex items-center justify-center shrink-0">
              <Building2 size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-black tracking-tight text-foreground leading-tight">Anlagenverwaltung</h1>
              <p className="text-xs text-muted font-medium leading-tight">
                Übersicht, Aktivierung und Abschreibung.
              </p>
            </div>
            <button className="h-8 px-3 rounded-full bg-foreground text-white text-xs font-bold hover:bg-foreground inline-flex items-center gap-1 shrink-0">
              <Plus size={12} />
              Anlage erfassen
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide font-bold text-muted">Anlagen gesamt</div>
              <div className="text-sm font-bold text-foreground mt-0.5">{totals.totalAssets} <span className="text-xs font-medium text-muted">({totals.activeAssets} aktiv)</span></div>
            </div>
            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide font-bold text-muted">Restbuchwert</div>
              <div className="text-sm font-bold text-foreground mt-0.5">{euro(totals.totalResidual)} <span className="text-xs font-medium text-muted">AK {euro(totals.totalAcquisition)}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={13} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Anlage suchen (Nr., Name, Klasse, KSt.)"
                className="w-full h-8 rounded-lg border border-border pl-8 pr-3 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'alle' | AssetStatus)}
                className="h-8 rounded-lg border border-border px-2 text-xs font-medium"
              >
                <option value="alle">Alle Status</option>
                <option value="entwurf">Entwurf</option>
                <option value="aktiv">Aktiv</option>
                <option value="voll_abgeschrieben">Voll abgeschrieben</option>
                <option value="verkauft">Verkauft</option>
                <option value="stillgelegt">Stillgelegt</option>
              </select>
              <button className="h-8 px-2.5 rounded-lg border border-border text-muted hover:bg-surface-muted">
                <Filter size={13} />
              </button>
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
                className={`w-full text-left rounded-xl border p-4 transition-colors duration-150 ease-out ${
                  selectedCard ? 'border-foreground bg-surface-muted' : 'border-border bg-surface hover:bg-surface-muted'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted font-bold">{asset.assetNumber}</div>
                    <div className="font-bold text-foreground truncate">{asset.name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {asset.assetClass} • {asset.costCenter} • {asset.location}
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-[11px] font-bold whitespace-nowrap ${pill.className}`}>
                    {pill.label}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-muted font-bold uppercase tracking-wide">AK</div>
                    <div className="text-muted font-bold">{euro(asset.acquisitionCost)}</div>
                  </div>
                  <div>
                    <div className="text-muted font-bold uppercase tracking-wide">RBW</div>
                    <div className="text-muted font-bold">{euro(asset.residualValue)}</div>
                  </div>
                  <div>
                    <div className="text-muted font-bold uppercase tracking-wide">Nächste AfA</div>
                    <div className="text-muted font-bold">{asset.nextDepreciation}</div>
                  </div>
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
              Keine Anlagen gefunden.
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 min-w-0 flex-col">
        {!selected ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-12 text-muted">Keine Anlage ausgewählt.</div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-border-subtle space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-muted">{selected.assetNumber}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusPill(selected.status).className}`}>
                      {statusPill(selected.status).label}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${selected.receiptLinked ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning'}`}>
                      {selected.receiptLinked ? 'Beleg verknüpft' : 'Beleg fehlt'}
                    </span>
                  </div>
                  <h2 className="text-base font-black text-foreground tracking-tight mt-0.5">{selected.name}</h2>
                  <p className="text-xs text-muted font-medium">
                    {selected.assetClass} • {selected.costCenter} • {selected.location}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5 justify-end shrink-0">
                  <button className="h-8 px-3 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1">
                    <ArrowRightLeft size={12} />
                    Bewegung
                  </button>
                  <button className="h-8 px-3 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1">
                    <CalendarClock size={12} />
                    AfA-Vorschau
                  </button>
                  <button className="h-8 px-3 rounded-full bg-foreground text-white text-xs font-bold hover:bg-foreground inline-flex items-center gap-1">
                    <Sparkles size={12} />
                    Bearbeiten
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
                <div className="rounded-lg border border-border px-3 py-2 bg-surface">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-muted">AK</div>
                  <div className="text-sm font-bold text-foreground mt-0.5">{euro(selected.acquisitionCost)}</div>
                </div>
                <div className="rounded-lg border border-border px-3 py-2 bg-surface">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-muted">RBW</div>
                  <div className="text-sm font-bold text-foreground mt-0.5">{euro(selected.residualValue)}</div>
                </div>
                <div className="rounded-lg border border-border px-3 py-2 bg-surface">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-muted">AfA p.a.</div>
                  <div className="text-sm font-bold text-foreground mt-0.5">{euro(selected.annualDepreciation)}</div>
                </div>
                <div className="rounded-lg border border-border px-3 py-2 bg-surface">
                  <div className="text-[10px] uppercase tracking-wide font-bold text-muted">Nächste AfA</div>
                  <div className="text-sm font-bold text-foreground mt-0.5">{selected.nextDepreciation}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {tabs.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`h-7 px-3 rounded-full text-xs font-bold border ${
                      activeTab === tab
                        ? 'bg-foreground text-white border-foreground'
                        : 'bg-surface text-muted border-border hover:bg-surface-muted'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6 grid grid-cols-1 gap-6 min-[1700px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <section className="min-w-0 space-y-4">
                <div className="rounded-xl border border-border bg-surface p-5">
                  <div className="text-sm font-bold text-foreground mb-3">{activeTab}</div>

                  {activeTab === 'Übersicht' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div className="space-y-2">
                        <div className="flex justify-between gap-3"><span className="text-muted">Lieferant</span><span className="font-bold text-foreground">{selected.supplier ?? '—'}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-muted">Rechnung</span><span className="font-bold text-foreground">{selected.invoiceRef ?? '—'}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-muted">Aktivierung</span><span className="font-bold text-foreground">{selected.activationDate}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-muted">Kostenstelle</span><span className="font-bold text-foreground">{selected.costCenter}</span></div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex justify-between gap-3"><span className="text-muted">Standort</span><span className="font-bold text-foreground">{selected.location}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-muted">Status</span><span className="font-bold text-foreground">{statusPill(selected.status).label}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-muted">Beleg</span><span className="font-bold text-foreground">{selected.receiptLinked ? 'Verknüpft' : 'Offen'}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-muted">Nächste AfA</span><span className="font-bold text-foreground">{selected.nextDepreciation}</span></div>
                      </div>
                    </div>
                  )}

                  {activeTab === 'Abschreibungsplan' && (
                    <div className="space-y-3">
                      {[
                        ['2026-03', euro(selected.annualDepreciation / 12), 'Offen', euro(Math.max(selected.residualValue - selected.annualDepreciation / 12, 0))],
                        ['2026-04', euro(selected.annualDepreciation / 12), 'Geplant', euro(Math.max(selected.residualValue - (selected.annualDepreciation / 6), 0))],
                        ['2026-05', euro(selected.annualDepreciation / 12), 'Geplant', euro(Math.max(selected.residualValue - (selected.annualDepreciation / 4), 0))],
                      ].map(([period, afa, status, rbw]) => (
                        <div key={period} className="grid grid-cols-4 gap-3 rounded-lg border border-border-subtle p-3 text-sm">
                          <div><div className="text-xs text-muted font-bold">Periode</div><div className="font-bold text-foreground">{period}</div></div>
                          <div><div className="text-xs text-muted font-bold">AfA</div><div className="font-bold text-foreground">{afa}</div></div>
                          <div><div className="text-xs text-muted font-bold">Status</div><div className="font-bold text-foreground">{status}</div></div>
                          <div><div className="text-xs text-muted font-bold">RBW danach</div><div className="font-bold text-foreground">{rbw}</div></div>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeTab === 'Bewegungen' && (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-border bg-surface-muted/60 p-4">
                        <div className="font-bold text-foreground">Zugang / Aktivierung</div>
                        <div className="text-sm text-muted mt-1">
                          {selected.activationDate} • Anschaffung {euro(selected.acquisitionCost)} • Status {statusPill(selected.status).label}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {['Teilabgang', 'Umbuchung', 'Stilllegung'].map((action) => (
                          <button key={action} className="rounded-xl border border-border p-4 text-left hover:bg-surface-muted">
                            <div className="font-bold text-foreground">{action}</div>
                            <div className="text-sm text-muted mt-1">Wizard mit Auswirkungs-Vorschau (Mock)</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {!['Übersicht', 'Abschreibungsplan', 'Bewegungen'].includes(activeTab) && (
                    <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted">
                      {activeTab} — UI-Skeleton vorbereitet. Hier folgen Details, Tabellen und Workflows für produktive Nutzung.
                    </div>
                  )}
                </div>
              </section>

              <section className="min-w-0 space-y-4">
                <div className="rounded-xl border border-border bg-surface p-5">
                  <div className="text-sm font-bold text-foreground mb-3">Anlage erfassen (Wizard-Vorschau)</div>
                  <div className="space-y-2">
                    {[
                      ['1', 'Grunddaten', 'Bezeichnung, Anlagenklasse, Lieferant, Beleg'],
                      ['2', 'Anschaffung', 'Anschaffungs-/Rechnungs-/Aktivierungsdatum, AK netto/brutto'],
                      ['3', 'Abschreibung', 'Methode, Nutzungsdauer, AfA-Beginn'],
                      ['4', 'Kontierung', 'Anlagenkonto, AfA-Konto, Gegenkonto, Kostenstelle'],
                      ['5', 'Prüfen & Aktivieren', 'Validierung, Vorschau, Aktivierung'],
                    ].map(([step, title, desc]) => (
                      <div key={step} className="flex gap-3 rounded-lg border border-border-subtle p-3">
                        <div className="w-7 h-7 rounded-full bg-foreground text-white text-xs font-bold flex items-center justify-center shrink-0">
                          {step}
                        </div>
                        <div>
                          <div className="text-sm font-bold text-foreground">{title}</div>
                          <div className="text-xs text-muted">{desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-surface p-5">
                  <div className="text-sm font-bold text-foreground mb-3">Quick Actions</div>
                  <div className="space-y-2">
                    <button className="w-full px-4 py-3 rounded-xl border border-border text-left hover:bg-surface-muted inline-flex items-center gap-2">
                      <FileText size={16} className="text-muted" />
                      <span className="font-bold text-foreground">Beleg anzeigen / verknüpfen</span>
                    </button>
                    <button className="w-full px-4 py-3 rounded-xl border border-border text-left hover:bg-surface-muted inline-flex items-center gap-2">
                      <Archive size={16} className="text-muted" />
                      <span className="font-bold text-foreground">AfA-Buchungen prüfen</span>
                    </button>
                    <button className="w-full px-4 py-3 rounded-xl border border-border text-left hover:bg-surface-muted inline-flex items-center gap-2">
                      <ArrowRightLeft size={16} className="text-muted" />
                      <span className="font-bold text-foreground">Abgang / Umbuchung erfassen</span>
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
