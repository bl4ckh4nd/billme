import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Building2, Search } from 'lucide-react';
import { Button } from '@billme/ui';
import type { AssetDepreciationScheduleEntry, AssetItem, AssetStatus } from '../domain/assetTypes';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
import type { AssetUpsertInput } from '../domain/assetTypes';
import { permissionContextForRole } from '../mocks/users';
import { toAccountingActorRole, type UserRole } from '../types';

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
    entwurf: { label: 'Entwurf', className: 'bg-warning-bg text-warning' },
    aktiv: { label: 'Aktiv', className: 'bg-success-bg text-success' },
    voll_abgeschrieben: { label: 'Voll abgeschrieben', className: 'bg-border-subtle text-foreground' },
    verkauft: { label: 'Verkauft', className: 'bg-info-bg text-info' },
    stillgelegt: { label: 'Stillgelegt', className: 'bg-error-bg text-error' },
  };
  return map[status];
}

type AssetFormState = {
  id?: string;
  assetNumber: string;
  name: string;
  assetClass: string;
  status: 'entwurf' | 'aktiv';
  activationDate: string;
  acquisitionCost: string;
  usefulLifeYears: string;
  depreciationMethod: AssetUpsertInput['depreciationMethod'];
  costCenter: string;
  location: string;
  receiptLinked: boolean;
  supplier: string;
  invoiceRef: string;
  assetAccountNumber: string;
  reason: string;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formFromAsset(asset?: AssetItem, activate = false): AssetFormState {
  return {
    id: asset?.id,
    assetNumber: asset?.assetNumber ?? '',
    name: asset?.name ?? '',
    assetClass: asset?.assetClass ?? '',
    status: activate ? 'aktiv' : asset?.status === 'aktiv' ? 'aktiv' : 'entwurf',
    activationDate: asset?.activationDate ?? today(),
    acquisitionCost: asset ? String(asset.acquisitionCost) : '',
    usefulLifeYears: asset?.usefulLifeYears ? String(asset.usefulLifeYears) : '',
    depreciationMethod: asset?.depreciationMethod ?? 'linear',
    costCenter: asset?.costCenter ?? '',
    location: asset?.location ?? '',
    receiptLinked: asset?.receiptLinked ?? false,
    supplier: asset?.supplier ?? '',
    invoiceRef: asset?.invoiceRef ?? '',
    assetAccountNumber: asset?.assetAccountNumber ?? '',
    reason: '',
  };
}

interface AssetEditorProps {
  form: AssetFormState;
  busy: boolean;
  onChange: <K extends keyof AssetFormState>(key: K, value: AssetFormState[K]) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function AssetEditor({ form, busy, onChange, onSubmit, onCancel }: AssetEditorProps) {
  const input = (key: keyof AssetFormState) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = event.currentTarget.type === 'checkbox'
      ? (event.currentTarget as HTMLInputElement).checked
      : event.currentTarget.value;
    onChange(key, value as AssetFormState[typeof key]);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <form
        className="mx-auto max-w-4xl rounded-2xl border border-border bg-surface p-5 space-y-5"
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        aria-busy={busy}
      >
        <div>
          <h2 className="text-base font-black text-foreground">{form.id ? 'Anlage bearbeiten' : 'Neue Anlage'}</h2>
          <p className="mt-1 text-sm text-muted">Speichern und Aktivieren erzeugen jeweils einen nachvollziehbaren Audit-Eintrag.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {([
            ['assetNumber', 'Anlagennummer', 'z. B. ANL-2026-010'],
            ['name', 'Bezeichnung', 'z. B. Server'],
            ['assetClass', 'Anlagenklasse', 'z. B. IT-Hardware'],
            ['costCenter', 'Kostenstelle', 'z. B. ADM-01'],
            ['location', 'Standort', 'z. B. Berlin HQ'],
            ['assetAccountNumber', 'Anlagenkonto', 'z. B. 0440'],
            ['supplier', 'Lieferant', 'Optional'],
            ['invoiceRef', 'Rechnungsreferenz', 'Optional'],
          ] as const).map(([key, label, placeholder]) => (
            <label key={key} className="space-y-1 text-sm font-semibold text-foreground">
              <span>{label}{['assetNumber', 'name', 'assetClass', 'costCenter', 'location', 'assetAccountNumber'].includes(key) ? ' *' : ''}</span>
              <input
                value={form[key] as string}
                onChange={input(key)}
                placeholder={placeholder}
                required={['assetNumber', 'name', 'assetClass', 'costCenter', 'location', 'assetAccountNumber'].includes(key)}
                className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm"
              />
            </label>
          ))}
          <label className="space-y-1 text-sm font-semibold text-foreground">
            <span>Aktivierungsdatum *</span>
            <input type="date" value={form.activationDate} onChange={input('activationDate')} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" />
          </label>
          <label className="space-y-1 text-sm font-semibold text-foreground">
            <span>Anschaffungskosten netto *</span>
            <input type="number" min="0" step="0.01" value={form.acquisitionCost} onChange={input('acquisitionCost')} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" />
          </label>
          <label className="space-y-1 text-sm font-semibold text-foreground">
            <span>Nutzungsdauer in Jahren</span>
            <input type="number" min="1" step="1" value={form.usefulLifeYears} onChange={input('usefulLifeYears')} className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" />
          </label>
          <label className="space-y-1 text-sm font-semibold text-foreground">
            <span>Abschreibungsmethode *</span>
            <select value={form.depreciationMethod} onChange={input('depreciationMethod')} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm">
              <option value="linear">Linear</option>
              <option value="gwg">GWG</option>
              <option value="pool">Pool</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-semibold text-foreground">
            <span>Status *</span>
            <select value={form.status} onChange={input('status')} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm">
              <option value="entwurf">Entwurf</option>
              <option value="aktiv">Aktiv</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <input type="checkbox" checked={form.receiptLinked} onChange={input('receiptLinked')} className="h-4 w-4 rounded border-border" />
          Beleg ist verknüpft
        </label>
        <label className="block space-y-1 text-sm font-semibold text-foreground">
          <span>Audit-Grund *</span>
          <textarea value={form.reason} onChange={input('reason')} required minLength={1} rows={2} placeholder="Warum wird die Anlage geändert?" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm" />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onCancel} disabled={busy} variant="secondary" size="sm" className="h-9 px-4">Abbrechen</Button>
          <Button type="submit" disabled={busy} variant="dark" size="sm" className="h-9 px-4">{busy ? 'Speichere…' : 'Anlage speichern'}</Button>
        </div>
      </form>
    </div>
  );
}

export default function AssetManagementView({ dataAdapter, role = 'admin' }: { dataAdapter?: ProAccountingDataAdapter; role?: UserRole }) {
  const canMutate = permissionContextForRole(role).canMutate;
  const accountingActorRole = toAccountingActorRole(role);
  const [assets, setAssets] = useState<AssetItem[]>(() => (dataAdapter ? [] : mockAssets));
  const [schedule, setSchedule] = useState<AssetDepreciationScheduleEntry[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AssetFormState | null>(null);
  const [busyAction, setBusyAction] = useState<'save' | 'depreciation' | 'disposal' | null>(null);
  const [depreciationYear, setDepreciationYear] = useState(String(new Date().getFullYear()));
  const [postingDate, setPostingDate] = useState(today());
  const [depreciationReason, setDepreciationReason] = useState('');
  const [disposalDate, setDisposalDate] = useState(today());
  const [disposalProceeds, setDisposalProceeds] = useState('0');
  const [disposalTaxRate, setDisposalTaxRate] = useState<'0' | '7' | '19'>('19');
  const [proceedsAccountNumber, setProceedsAccountNumber] = useState('');
  const [disposalReason, setDisposalReason] = useState('');
  const [disposalConfirmed, setDisposalConfirmed] = useState(false);
  const mutationInFlightRef = useRef(false);
  const scheduleRequestRef = useRef(0);
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

  useEffect(() => {
    setEditForm(null);
    setMutationError(null);
    setMutationMessage(null);
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

  const loadScheduleForAsset = useCallback(async (assetId: string) => {
    const requestId = ++scheduleRequestRef.current;
    const load = dataAdapter?.getDepreciationSchedule;
    if (!load) {
      setSchedule([]);
      setScheduleError(null);
      return;
    }
    setScheduleError(null);
    try {
      const nextSchedule = await load(assetId);
      if (requestId !== scheduleRequestRef.current) return;
      setSchedule(nextSchedule);
    } catch (error) {
      if (requestId !== scheduleRequestRef.current) return;
      setSchedule([]);
      setScheduleError(error instanceof Error ? error.message : 'Abschreibungsplan konnte nicht geladen werden.');
    }
  }, [dataAdapter]);

  useEffect(() => {
    if (!selected) {
      scheduleRequestRef.current += 1;
      setSchedule([]);
      setScheduleError(null);
      return;
    }
    void loadScheduleForAsset(selected.id);
  }, [loadScheduleForAsset, selected?.id]);

  const beginMutation = (action: 'save' | 'depreciation' | 'disposal') => {
    if (busyAction !== null || mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    setBusyAction(action);
    return true;
  };

  const endMutation = () => {
    mutationInFlightRef.current = false;
    setBusyAction(null);
  };

  const reloadCanonical = async (assetId: string) => {
    const list = dataAdapter?.listAssets;
    if (!list) return;
    const requestId = ++scheduleRequestRef.current;
    let nextSelectedId = assetId;
    try {
      const nextAssets = await list();
      setAssets(nextAssets);
      nextSelectedId = nextAssets.some((asset) => asset.id === assetId) ? assetId : nextAssets[0]?.id ?? '';
      setSelectedId(nextSelectedId);
      setAssetsError(null);
    } catch (error) {
      setAssetsError(error instanceof Error ? error.message : 'Anlagen konnten nicht aktualisiert werden.');
      return;
    }
    if (requestId !== scheduleRequestRef.current) return;
    if (nextSelectedId) await loadScheduleForAsset(nextSelectedId);
    else {
      setSchedule([]);
      setScheduleError(null);
    }
  };

  const updateEditForm = <K extends keyof AssetFormState>(key: K, value: AssetFormState[K]) => {
    setEditForm((current) => current ? { ...current, [key]: value } : current);
  };

  const submitAsset = async () => {
    if (!canMutate || !editForm || !dataAdapter?.upsertAsset) return;
    const acquisitionCost = Number(editForm.acquisitionCost.replace(',', '.'));
    const usefulLifeYears = editForm.usefulLifeYears.trim() ? Number(editForm.usefulLifeYears) : undefined;
    if (!editForm.reason.trim()) {
      setMutationError('Bitte einen Audit-Grund angeben.');
      return;
    }
    if (!Number.isFinite(acquisitionCost) || acquisitionCost < 0 || (usefulLifeYears !== undefined && (!Number.isInteger(usefulLifeYears) || usefulLifeYears < 1))) {
      setMutationError('Bitte gültige Anschaffungskosten und Nutzungsdauer angeben.');
      return;
    }
    if (!beginMutation('save')) return;
    setMutationError(null);
    setMutationMessage(null);
    try {
      const saved = await dataAdapter.upsertAsset({
        id: editForm.id,
        assetNumber: editForm.assetNumber.trim(),
        name: editForm.name.trim(),
        assetClass: editForm.assetClass.trim(),
        status: editForm.status,
        activationDate: editForm.activationDate,
        acquisitionCost,
        usefulLifeYears,
        depreciationMethod: editForm.depreciationMethod,
        costCenter: editForm.costCenter.trim(),
        location: editForm.location.trim(),
        receiptLinked: editForm.receiptLinked,
        supplier: editForm.supplier.trim() || undefined,
        invoiceRef: editForm.invoiceRef.trim() || undefined,
        assetAccountNumber: editForm.assetAccountNumber.trim(),
      }, editForm.reason.trim());
      await reloadCanonical(saved.id);
      setSelectedId(saved.id);
      setEditForm(null);
      setMutationMessage(saved.status === 'aktiv' ? 'Anlage gespeichert und aktiviert.' : 'Anlage gespeichert.');
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Anlage konnte nicht gespeichert werden.');
    } finally {
      endMutation();
    }
  };

  const postDepreciation = async () => {
    if (!canMutate || !selected || !dataAdapter?.runDepreciation) return;
    const year = Number(depreciationYear);
    if (!depreciationReason.trim()) {
      setMutationError('Bitte einen Audit-Grund für die AfA-Buchung angeben.');
      return;
    }
    if (!Number.isInteger(year) || year < 2000 || !postingDate) {
      setMutationError('Bitte ein gültiges AfA-Jahr und Buchungsdatum angeben.');
      return;
    }
    if (!beginMutation('depreciation')) return;
    setMutationError(null);
    setMutationMessage(null);
    try {
      const result = await dataAdapter.runDepreciation({
        assetId: selected.id,
        year,
        postingDate,
        reason: depreciationReason.trim(),
        actorRole: accountingActorRole,
      });
      await reloadCanonical(result.asset.id);
      setMutationMessage(`AfA ${year} gebucht${result.journalEntryId ? ` (Journal ${result.journalEntryId})` : ''}.`);
      setDepreciationReason('');
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'AfA konnte nicht gebucht werden.');
    } finally {
      endMutation();
    }
  };

  const dispose = async () => {
    if (!canMutate || !selected || !dataAdapter?.disposeAsset) return;
    const proceeds = Number(disposalProceeds.replace(',', '.'));
    const taxRate = Number(disposalTaxRate);
    if (!disposalConfirmed) {
      setMutationError('Bitte die Ausbuchung ausdrücklich bestätigen.');
      return;
    }
    if (!disposalReason.trim()) {
      setMutationError('Bitte einen Audit-Grund für die Ausbuchung angeben.');
      return;
    }
    if (!Number.isFinite(proceeds) || proceeds < 0 || !disposalDate || ![0, 7, 19].includes(taxRate)) {
      setMutationError('Bitte gültige Ausbuchungsdaten angeben.');
      return;
    }
    if (!beginMutation('disposal')) return;
    setMutationError(null);
    setMutationMessage(null);
    try {
      const result = await dataAdapter.disposeAsset({
        assetId: selected.id,
        disposalDate,
        proceeds,
        taxRate: taxRate as 0 | 7 | 19,
        proceedsAccountNumber: proceedsAccountNumber.trim() || undefined,
        reason: disposalReason.trim(),
        actorRole: accountingActorRole,
      });
      await reloadCanonical(result.asset.id);
      setMutationMessage(`Anlage ${result.asset.status === 'verkauft' ? 'verkauft' : 'stillgelegt'}; Ergebnis ${euro(result.gainLoss)}${result.journalEntryId ? ` (Journal ${result.journalEntryId})` : ''}.`);
      setDisposalReason('');
      setDisposalConfirmed(false);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Anlage konnte nicht ausgebucht werden.');
    } finally {
      endMutation();
    }
  };

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
      <div className="flex min-h-0 flex-col border-b border-subtle xl:w-96 xl:min-w-96 xl:max-w-96 xl:border-b-0 xl:border-r">
        <div className="px-4 py-3 border-b border-subtle space-y-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-dark-base text-accent flex items-center justify-center shrink-0">
              <Building2 size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h1 className="text-sm font-black tracking-tight text-foreground leading-tight">Anlagenverwaltung</h1>
                {canMutate && dataAdapter?.upsertAsset && (
                  <Button
                    type="button"
                    onClick={() => { if (busyAction !== null) return; setMutationError(null); setMutationMessage(null); setEditForm(formFromAsset()); }}
                    disabled={busyAction !== null}
                    variant="dark"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                  >
                    Neue Anlage
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted font-medium leading-tight">Übersicht, Aktivierung und Abschreibung.</p>
            </div>
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

          <div className="grid grid-cols-2 gap-2">
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
                  selectedCard ? 'border-dark-base bg-surface-muted' : 'border-border bg-surface hover:bg-surface-muted'
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
                    <div className="text-foreground font-bold">{euro(asset.acquisitionCost)}</div>
                  </div>
                  <div>
                    <div className="text-muted font-bold uppercase tracking-wide">RBW</div>
                    <div className="text-foreground font-bold">{euro(asset.residualValue)}</div>
                  </div>
                  <div>
                    <div className="text-muted font-bold uppercase tracking-wide">Nächste AfA</div>
                    <div className="text-foreground font-bold">{asset.nextDepreciation}</div>
                  </div>
                </div>
              </button>
            );
          })}
          {assetsError && <div className="rounded-xl border border-error-border bg-error-bg p-4 text-sm text-error" role="alert" aria-live="assertive">{assetsError}</div>}
          {filtered.length === 0 && !assetsError && (
            <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
              Keine Anlagen gefunden.
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 min-w-0 flex-col">
        {mutationError && <div className="mx-6 mt-4 rounded-xl border border-error-border bg-error-bg p-3 text-sm text-error" role="alert" aria-live="assertive">{mutationError}</div>}
        {mutationMessage && <div className="mx-6 mt-4 rounded-xl border border-success-border bg-success-bg p-3 text-sm text-success" role="status" aria-live="polite">{mutationMessage}</div>}
        {editForm ? (
          <AssetEditor
            form={editForm}
            busy={busyAction === 'save'}
            onChange={updateEditForm}
            onSubmit={() => { void submitAsset(); }}
            onCancel={() => setEditForm(null)}
          />
        ) : !selected ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-12 text-muted">Keine Anlage ausgewählt.</div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-subtle space-y-2.5">
              <div className="flex items-start justify-between gap-3">
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
                {canMutate && dataAdapter?.upsertAsset && ['entwurf', 'aktiv'].includes(selected.status) && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" onClick={() => { if (busyAction !== null) return; setMutationError(null); setMutationMessage(null); setEditForm(formFromAsset(selected)); }} disabled={busyAction !== null} variant="secondary" size="sm" className="h-8 px-3 text-xs">Bearbeiten</Button>
                    {selected.status === 'entwurf' && <Button type="button" onClick={() => { if (busyAction !== null) return; setMutationError(null); setMutationMessage(null); setEditForm(formFromAsset(selected, true)); }} disabled={busyAction !== null} variant="dark" size="sm" className="h-8 px-3 text-xs">Aktivieren</Button>}
                  </div>
                )}
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
                        ? 'bg-dark-base text-background border-dark-base'
                        : 'bg-surface text-muted border-border hover:bg-surface-muted'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
              <section className="min-w-0 space-y-4">
                <div className="rounded-2xl border border-border bg-surface p-5">
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
                      {scheduleError && <div className="rounded-lg border border-error-border bg-error-bg p-3 text-sm text-error" role="alert">{scheduleError}</div>}
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
                        <div key={period.id} className="grid grid-cols-4 gap-3 rounded-lg border border-subtle p-3 text-sm">
                          <div><div className="text-xs text-muted font-bold">Jahr</div><div className="font-bold text-foreground">{period.year}</div></div>
                          <div><div className="text-xs text-muted font-bold">AfA</div><div className="font-bold text-foreground">{euro(period.amount)}</div></div>
                          <div><div className="text-xs text-muted font-bold">Status</div><div className="font-bold text-foreground">{period.status === 'posted' ? 'Gebucht' : period.status === 'cancelled' ? 'Storniert' : 'Geplant'}</div></div>
                          <div><div className="text-xs text-muted font-bold">RBW danach</div><div className="font-bold text-foreground">{euro(Math.max(selected.acquisitionCost - depreciated, 0))}</div></div>
                        </div>
                      );})}
                    </div>
                  )}

                  {activeTab === 'Bewegungen' && (
                    <div className="space-y-3">
                      {!schedule.length && dataAdapter ? <div className="text-sm text-muted">Kein Abschreibungsplan vorhanden.</div> : null}
                      <div className="rounded-xl border border-border bg-surface-muted/60 p-4">
                        <div className="font-bold text-foreground">Zugang / Aktivierung</div>
                        <div className="text-sm text-muted mt-1">
                          {selected.activationDate} • Anschaffung {euro(selected.acquisitionCost)} • Status {statusPill(selected.status).label}
                        </div>
                      </div>
                    </div>
                  )}

                  {!['Übersicht', 'Abschreibungsplan', 'Bewegungen'].includes(activeTab) && (
                    <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted">
                      Für diesen Bereich liegen noch keine Daten vor.
                    </div>
                  )}
                </div>
              </section>

              <section className="min-w-0 space-y-4">
                {canMutate && dataAdapter?.runDepreciation && selected.status === 'aktiv' && (
                  <form className="rounded-2xl border border-border bg-surface p-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void postDepreciation(); }} aria-busy={busyAction === 'depreciation'}>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">Abschreibung buchen</h3>
                      <p className="mt-1 text-xs text-muted">Die Buchung wird erst nach erfolgreicher Antwort in Liste und Plan übernommen.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="space-y-1 text-sm font-semibold text-foreground"><span>Geschäftsjahr *</span><input type="number" min="2000" step="1" value={depreciationYear} onChange={(event) => setDepreciationYear(event.target.value)} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" /></label>
                      <label className="space-y-1 text-sm font-semibold text-foreground"><span>Buchungsdatum *</span><input type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" /></label>
                    </div>
                    <label className="block space-y-1 text-sm font-semibold text-foreground"><span>Audit-Grund *</span><textarea value={depreciationReason} onChange={(event) => setDepreciationReason(event.target.value)} required rows={2} placeholder="Warum wird die AfA jetzt gebucht?" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm" /></label>
                    <Button type="submit" disabled={busyAction !== null} variant="dark" size="sm" className="h-9 px-4">{busyAction === 'depreciation' ? 'Buche…' : 'AfA buchen'}</Button>
                  </form>
                )}

                {canMutate && dataAdapter?.disposeAsset && !['verkauft', 'stillgelegt'].includes(selected.status) && (
                  <form className="rounded-2xl border border-border bg-surface p-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void dispose(); }} aria-busy={busyAction === 'disposal'}>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">Anlage ausbuchen</h3>
                      <p className="mt-1 text-xs text-muted">Verkaufserlös 0,00 € führt zur Stilllegung; ein Erlös führt zum Verkauf.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="space-y-1 text-sm font-semibold text-foreground"><span>Ausbuchungsdatum *</span><input type="date" value={disposalDate} onChange={(event) => setDisposalDate(event.target.value)} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" /></label>
                      <label className="space-y-1 text-sm font-semibold text-foreground"><span>Verkaufserlös netto *</span><input type="number" min="0" step="0.01" value={disposalProceeds} onChange={(event) => setDisposalProceeds(event.target.value)} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" /></label>
                      <label className="space-y-1 text-sm font-semibold text-foreground"><span>Umsatzsteuersatz *</span><select value={disposalTaxRate} onChange={(event) => setDisposalTaxRate(event.target.value as '0' | '7' | '19')} required className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm"><option value="0">0 %</option><option value="7">7 %</option><option value="19">19 %</option></select></label>
                      <label className="space-y-1 text-sm font-semibold text-foreground"><span>Erlöskonto / Zahlungskonto</span><input value={proceedsAccountNumber} onChange={(event) => setProceedsAccountNumber(event.target.value)} placeholder="Optional, z. B. 1200" className="h-9 w-full rounded-lg border border-border bg-surface-muted px-3 text-sm" /></label>
                    </div>
                    <label className="block space-y-1 text-sm font-semibold text-foreground"><span>Audit-Grund *</span><textarea value={disposalReason} onChange={(event) => setDisposalReason(event.target.value)} required rows={2} placeholder="Warum wird die Anlage ausgebucht?" className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm" /></label>
                    <label className="flex items-start gap-2 text-sm text-foreground"><input type="checkbox" checked={disposalConfirmed} onChange={(event) => setDisposalConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-border" /><span>Ich bestätige die Ausbuchung und die daraus folgende Journalbuchung.</span></label>
                    <Button type="submit" disabled={busyAction !== null || !disposalConfirmed} variant="dark" size="sm" className="h-9 px-4">{busyAction === 'disposal' ? 'Buche…' : 'Ausbuchung bestätigen'}</Button>
                  </form>
                )}

                {!dataAdapter && <div className="rounded-2xl border border-dashed border-border bg-surface-muted p-5 text-sm text-muted">Mutationen sind im Demo-Modus deaktiviert.</div>}
                {dataAdapter && !dataAdapter.upsertAsset && !dataAdapter.runDepreciation && !dataAdapter.disposeAsset && <div className="rounded-2xl border border-dashed border-border bg-surface-muted p-5 text-sm text-muted">Anlagen-Mutationen sind für diese Verbindung nicht verfügbar.</div>}
              </section>

            </div>
          </>
        )}
      </div>
    </div>
  );
}
