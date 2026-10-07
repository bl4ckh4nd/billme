import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Search } from 'lucide-react';
import {
  Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, Metric, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
  EMPTY_VALUE, cn, formatEmptyValue, type BadgeTone,
} from '@billme/ui';
import type { AssetDepreciationScheduleEntry, AssetItem, AssetStatus } from '../domain/assetTypes';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import type { AssetUpsertInput } from '../domain/assetTypes';
import { permissionContextForRole } from '../domain/permissions';
import { localToday } from '../domain/reportDates';
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
    nextDepreciation: EMPTY_VALUE,
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

const statusBadge: Record<AssetStatus, { label: string; tone: BadgeTone }> = {
  entwurf: { label: 'Entwurf', tone: 'warning' },
  aktiv: { label: 'Aktiv', tone: 'success' },
  voll_abgeschrieben: { label: 'Voll abgeschrieben', tone: 'neutral' },
  verkauft: { label: 'Verkauft', tone: 'info' },
  stillgelegt: { label: 'Stillgelegt', tone: 'error' },
};

const bannerClass = 'rounded-control border px-3 py-2.5 text-control';
const cardHeadClass = 'border-b border-border px-3.5 py-3';

// ponytail: the star sits inside the label because the specs address fields as 'Audit-Grund *'; use Field's required mark once those names drop the star.
const requiredLabel = (text: string) => <>{text} <span className="text-error-text">*</span></>;

type AssetFormState = {
  id?: string;
  assetNumber: string;
  name: string;
  assetClass: string;
  status: AssetStatus;
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
  return localToday();
}

function formFromAsset(asset?: AssetItem, activate = false): AssetFormState {
  return {
    id: asset?.id,
    assetNumber: asset?.assetNumber ?? '',
    name: asset?.name ?? '',
    assetClass: asset?.assetClass ?? '',
    status: activate ? 'aktiv' : asset?.status ?? 'entwurf',
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
  const accountingOwned = Boolean(form.id && form.status !== 'entwurf');
  const input = (key: keyof AssetFormState) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = event.currentTarget.type === 'checkbox'
      ? (event.currentTarget as HTMLInputElement).checked
      : event.currentTarget.value;
    onChange(key, value as AssetFormState[typeof key]);
  };

  return (
    <Card padding="none" className="max-w-4xl">
      <form
        noValidate
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        aria-busy={busy}
      >
        <CardHeader className={cardHeadClass} title={form.id ? 'Anlage bearbeiten' : 'Neue Anlage'} subtitle="Speichern und Aktivieren erzeugen jeweils einen nachvollziehbaren Audit-Eintrag." />
        <div className="flex flex-col gap-3 p-3.5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {([
              ['assetNumber', 'Anlagennummer', 'z. B. ANL-2026-010'],
              ['name', 'Bezeichnung', 'z. B. Server'],
              ['assetClass', 'Anlagenklasse', 'z. B. IT-Hardware'],
              ['costCenter', 'Kostenstelle', 'z. B. ADM-01'],
              ['location', 'Standort', 'z. B. Berlin HQ'],
              ['assetAccountNumber', 'Anlagenkonto', 'z. B. 0440'],
              ['supplier', 'Lieferant', 'Optional'],
              ['invoiceRef', 'Rechnungsreferenz', 'Optional'],
            ] as const).map(([key, label, placeholder]) => {
              const required = ['assetNumber', 'name', 'assetClass', 'costCenter', 'location', 'assetAccountNumber'].includes(key);
              return (
                <Field key={key} id={`asset-${key}`} label={required ? requiredLabel(label) : label}>
                  <Input fullWidth value={form[key] as string} onChange={input(key)} placeholder={placeholder} required={required} />
                </Field>
              );
            })}
            <Field id="asset-activation-date" label={requiredLabel('Aktivierungsdatum')}>
              <Input fullWidth type="date" value={form.activationDate} onChange={input('activationDate')} required />
            </Field>
            <Field id="asset-acquisition-cost" label={requiredLabel('Anschaffungskosten netto')}>
              <Input fullWidth type="number" min="0" step="0.01" value={form.acquisitionCost} onChange={input('acquisitionCost')} required />
            </Field>
            <Input label="Nutzungsdauer in Jahren" fullWidth type="number" min="1" step="1" value={form.usefulLifeYears} onChange={input('usefulLifeYears')} />
            <Field id="asset-depreciation-method" label={requiredLabel('Abschreibungsmethode')}>
              <Select fullWidth value={form.depreciationMethod} onChange={input('depreciationMethod')} required>
                <option value="linear">Linear</option>
                <option value="gwg">GWG</option>
                <option value="pool">Pool</option>
              </Select>
            </Field>
            <Field
              id="asset-status"
              label={requiredLabel('Status')}
              hint={accountingOwned ? 'Gebuchte Anlagen behalten ihren Accounting-Status. Für eine Korrektur bitte den Anlagen-Korrekturfluss verwenden.' : undefined}
            >
              <Select fullWidth value={form.status} onChange={input('status')} required disabled={accountingOwned}>
                <option value="entwurf">Entwurf</option>
                <option value="aktiv">Aktiv</option>
                <option value="voll_abgeschrieben">Voll abgeschrieben</option>
                <option value="verkauft">Verkauft</option>
                <option value="stillgelegt">Stillgelegt</option>
              </Select>
            </Field>
          </div>
          <Checkbox label="Beleg ist verknüpft" checked={form.receiptLinked} onChange={input('receiptLinked')} />
          <Field id="asset-reason" label={requiredLabel('Audit-Grund')}>
            <Textarea fullWidth value={form.reason} onChange={input('reason')} required minLength={1} rows={2} placeholder="Warum wird die Anlage geändert?" />
          </Field>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-3.5 py-3">
          <Button type="button" onClick={onCancel} disabled={busy} variant="secondary">Abbrechen</Button>
          <Button type="submit" disabled={busy} variant="dark">{busy ? 'Speichere…' : 'Anlage speichern'}</Button>
        </div>
      </form>
    </Card>
  );
}

export default function AssetManagementView({ dataAdapter, role = 'admin' }: { dataAdapter?: ProAccountingDataAdapter; role?: UserRole }) {
  const canMutate = permissionContextForRole(role).canMutate;
  const accountingActorRole = toAccountingActorRole(role);
  const [assets, setAssets] = useState<AssetItem[]>(() => (dataAdapter ? [] : mockAssets));
  const [assetsLoading, setAssetsLoading] = useState(Boolean(dataAdapter));
  const [schedule, setSchedule] = useState<AssetDepreciationScheduleEntry[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(Boolean(dataAdapter));
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
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

  const loadAssets = useCallback(async () => {
    if (!dataAdapter) {
      setAssets(mockAssets);
      setAssetsError(null);
      setAssetsLoading(false);
      return;
    }
    const list = dataAdapter.listAssets;
    if (!list) {
      setAssets([]);
      setAssetsError('Anlagen konnten nicht geladen werden.');
      setAssetsLoading(false);
      return;
    }
    setAssetsError(null);
    setAssetsLoading(true);
    try {
      setAssets(await list());
    } catch (error) {
      setAssets([]);
      setAssetsError(error instanceof Error ? error.message : 'Anlagen konnten nicht geladen werden.');
    } finally {
      setAssetsLoading(false);
    }
  }, [dataAdapter]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    setEditForm(null);
    setFeedback(null);
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
      setScheduleLoading(false);
      return;
    }
    setScheduleError(null);
    setScheduleLoading(true);
    try {
      const nextSchedule = await load(assetId);
      if (requestId !== scheduleRequestRef.current) return;
      setSchedule(nextSchedule);
    } catch (error) {
      if (requestId !== scheduleRequestRef.current) return;
      setSchedule([]);
      setScheduleError(error instanceof Error ? error.message : 'Abschreibungsplan konnte nicht geladen werden.');
    } finally {
      if (requestId === scheduleRequestRef.current) setScheduleLoading(false);
    }
  }, [dataAdapter]);

  useEffect(() => {
    if (!selected) {
      scheduleRequestRef.current += 1;
      setSchedule([]);
      setScheduleError(null);
      setScheduleLoading(false);
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
    const missingFields = [
      ['Anlagennummer', editForm.assetNumber],
      ['Bezeichnung', editForm.name],
      ['Anlagenklasse', editForm.assetClass],
      ['Kostenstelle', editForm.costCenter],
      ['Standort', editForm.location],
      ['Anlagenkonto', editForm.assetAccountNumber],
      ['Aktivierungsdatum', editForm.activationDate],
      ['Anschaffungskosten netto', editForm.acquisitionCost],
      ['Abschreibungsmethode', editForm.depreciationMethod],
      ['Status', editForm.status],
    ].filter(([, value]) => !value.trim()).map(([label]) => label);
    if (missingFields.length > 0) {
      setFeedback({ kind: 'error', text: `Bitte Pflichtfelder ausfüllen: ${missingFields.join(', ')}.` });
      return;
    }
    if (!editForm.reason.trim()) {
      setFeedback({ kind: 'error', text: 'Bitte einen Audit-Grund angeben.' });
      return;
    }
    if (!Number.isFinite(acquisitionCost) || acquisitionCost < 0 || (usefulLifeYears !== undefined && (!Number.isInteger(usefulLifeYears) || usefulLifeYears < 1))) {
      setFeedback({ kind: 'error', text: 'Bitte gültige Anschaffungskosten und Nutzungsdauer angeben.' });
      return;
    }
    if (!beginMutation('save')) return;
    setFeedback(null);
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
      setFeedback({ kind: 'success', text: saved.status === 'aktiv' ? 'Anlage gespeichert und aktiviert.' : 'Anlage gespeichert.' });
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Anlage konnte nicht gespeichert werden.' });
    } finally {
      endMutation();
    }
  };

  const postDepreciation = async () => {
    if (!canMutate || !selected || !dataAdapter?.runDepreciation) return;
    const year = Number(depreciationYear);
    if (!depreciationReason.trim()) {
      setFeedback({ kind: 'error', text: 'Bitte einen Audit-Grund für die AfA-Buchung angeben.' });
      return;
    }
    if (!Number.isInteger(year) || year < 2000 || !postingDate) {
      setFeedback({ kind: 'error', text: 'Bitte ein gültiges AfA-Jahr und Buchungsdatum angeben.' });
      return;
    }
    if (!beginMutation('depreciation')) return;
    setFeedback(null);
    try {
      const result = await dataAdapter.runDepreciation({
        assetId: selected.id,
        year,
        postingDate,
        reason: depreciationReason.trim(),
        actorRole: accountingActorRole,
      });
      await reloadCanonical(result.asset.id);
      setFeedback({ kind: 'success', text: `AfA ${year} gebucht${result.journalEntryId ? ` (Journal ${result.journalEntryId})` : ''}.` });
      setDepreciationReason('');
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'AfA konnte nicht gebucht werden.' });
    } finally {
      endMutation();
    }
  };

  const dispose = async () => {
    if (!canMutate || !selected || !dataAdapter?.disposeAsset) return;
    const proceeds = Number(disposalProceeds.replace(',', '.'));
    const taxRate = Number(disposalTaxRate);
    if (!disposalConfirmed) {
      setFeedback({ kind: 'error', text: 'Bitte die Ausbuchung ausdrücklich bestätigen.' });
      return;
    }
    if (!disposalReason.trim()) {
      setFeedback({ kind: 'error', text: 'Bitte einen Audit-Grund für die Ausbuchung angeben.' });
      return;
    }
    if (!Number.isFinite(proceeds) || proceeds < 0 || !disposalDate || ![0, 7, 19].includes(taxRate)) {
      setFeedback({ kind: 'error', text: 'Bitte gültige Ausbuchungsdaten angeben.' });
      return;
    }
    if (!beginMutation('disposal')) return;
    setFeedback(null);
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
      setFeedback({ kind: 'success', text: `Anlage ${result.asset.status === 'verkauft' ? 'verkauft' : 'stillgelegt'}; Ergebnis ${euro(result.gainLoss)}${result.journalEntryId ? ` (Journal ${result.journalEntryId})` : ''}.` });
      setDisposalReason('');
      setDisposalConfirmed(false);
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Anlage konnte nicht ausgebucht werden.' });
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

  const selectedStatus = selected ? statusBadge[selected.status] : null;
  const scheduleRows = schedule.length || dataAdapter || !selected ? schedule : [{
    id: 'fallback',
    assetId: selected.id,
    year: Number(selected.activationDate.slice(0, 4)),
    amount: selected.annualDepreciation,
    months: 12,
    status: 'planned' as const,
  }];

  return (
    <div className="flex h-full min-w-0 flex-col gap-3.5 overflow-hidden xl:flex-row">
      <Card padding="none" className="flex min-h-0 flex-col overflow-hidden xl:w-96 xl:shrink-0">
        <div className="space-y-3 border-b border-border p-3.5">
          <h2 className="sr-only">Anlagenverwaltung</h2>
          <p className="sr-only">Übersicht, Aktivierung und Abschreibung.</p>
          {!dataAdapter || (canMutate && dataAdapter.upsertAsset) ? (
            <div className="flex items-center justify-between gap-2">
              {!dataAdapter ? (
                <span className="inline-flex" role="status" title="Ohne verbundenes Anlagen-Backend zeigt diese Ansicht einen Demo-Datensatz.">
                  <Badge tone="warning">Beispieldaten</Badge>
                </span>
              ) : <span />}
              {canMutate && dataAdapter?.upsertAsset && (
                <Button
                  type="button"
                  onClick={() => { if (busyAction !== null) return; setFeedback(null); setEditForm(formFromAsset()); }}
                  disabled={busyAction !== null}
                  variant="dark"
                >
                  Neue Anlage
                </Button>
              )}
            </div>
          ) : null}

          <Metric marker="tick" label="Restbuchwert" value={euro(totals.totalResidual)} />
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Anlagen gesamt" value={totals.totalAssets} hint={`${totals.activeAssets} aktiv`} />
            <Metric label="Anschaffungskosten" value={euro(totals.totalAcquisition)} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Input
              type="text"
              fullWidth
              prefix={<Search size={14} />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Anlage suchen (Nr., Name, Klasse, KSt.)"
            />
            <Select fullWidth value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'alle' | AssetStatus)}>
              <option value="alle">Alle Status</option>
              <option value="entwurf">Entwurf</option>
              <option value="aktiv">Aktiv</option>
              <option value="voll_abgeschrieben">Voll abgeschrieben</option>
              <option value="verkauft">Verkauft</option>
              <option value="stillgelegt">Stillgelegt</option>
            </Select>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {assetsLoading ? <div className="p-3.5 text-control text-muted" role="status" aria-live="polite" aria-busy="true">Anlagen werden geladen…</div> : null}
          {!assetsLoading && filtered.map((asset) => {
            const status = statusBadge[asset.status];
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => setSelectedId(asset.id)}
                className={cn(
                  'block w-full border-b border-border px-3.5 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-muted motion-reduce:transition-none',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
                  selected?.id === asset.id && 'bg-accent-50 hover:bg-accent-50',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-caption tabular-nums text-muted">{asset.assetNumber}</div>
                    <div className="truncate text-control font-semibold text-foreground">{asset.name}</div>
                    <div className="mt-0.5 text-caption text-muted">
                      {asset.assetClass} • {asset.costCenter} • {asset.location}
                    </div>
                  </div>
                  <Badge tone={status.tone} className="shrink-0 whitespace-nowrap">{status.label}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-caption">
                  <div>
                    <div className="text-eyebrow uppercase text-muted">AK</div>
                    <div className="font-medium tabular-nums text-foreground">{euro(asset.acquisitionCost)}</div>
                  </div>
                  <div>
                    <div className="text-eyebrow uppercase text-muted">RBW</div>
                    <div className="font-medium tabular-nums text-foreground">{euro(asset.residualValue)}</div>
                  </div>
                  <div>
                    <div className="text-eyebrow uppercase text-muted">Nächste AfA</div>
                    <div className="font-medium tabular-nums text-foreground">{asset.nextDepreciation}</div>
                  </div>
                </div>
              </button>
            );
          })}
          {assetsError && <div className={`m-3.5 flex flex-wrap items-center gap-3 border-error-border bg-error-bg text-error-text ${bannerClass}`} role="alert" aria-live="assertive"><span>{assetsError}</span><Button type="button" size="sm" variant="secondary" onClick={() => void loadAssets()}>Erneut versuchen</Button></div>}
          {!assetsLoading && filtered.length === 0 && !assetsError && <EmptyState title="Keine Anlagen gefunden." />}
        </div>
      </Card>

      <div className="min-h-0 min-w-0 flex-1 space-y-3.5 overflow-y-auto">
        {feedback ? <div data-testid="asset-mutation-feedback" className={`${feedback.kind === 'error' ? 'border-error-border bg-error-bg text-error-text' : 'border-success-border bg-success-bg text-success-text'} ${bannerClass}`} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}>{feedback.text}</div> : null}
        {editForm ? (
          <AssetEditor
            form={editForm}
            busy={busyAction === 'save'}
            onChange={updateEditForm}
            onSubmit={() => { void submitAsset(); }}
            onCancel={() => setEditForm(null)}
          />
        ) : !selected || !selectedStatus ? (
          <Card padding="none"><EmptyState title="Keine Anlage ausgewählt." /></Card>
        ) : (
          <>
            <Card padding="none">
              <div className="flex flex-wrap items-start justify-between gap-3 px-3.5 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-caption tabular-nums text-muted">{selected.assetNumber}</span>
                    <Badge tone={selectedStatus.tone}>{selectedStatus.label}</Badge>
                    <Badge tone={selected.receiptLinked ? 'success' : 'warning'}>{selected.receiptLinked ? 'Beleg verknüpft' : 'Beleg fehlt'}</Badge>
                  </div>
                  <h2 className="mt-1 text-section text-foreground">{selected.name}</h2>
                  <p className="text-caption text-muted">
                    {selected.assetClass} • {selected.costCenter} • {selected.location}
                  </p>
                </div>
                {canMutate && dataAdapter?.upsertAsset && ['entwurf', 'aktiv'].includes(selected.status) && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" onClick={() => { if (busyAction !== null) return; setFeedback(null); setEditForm(formFromAsset(selected)); }} disabled={busyAction !== null} variant="secondary" size="sm">Bearbeiten</Button>
                    {selected.status === 'entwurf' && <Button type="button" onClick={() => { if (busyAction !== null) return; setFeedback(null); setEditForm(formFromAsset(selected, true)); }} disabled={busyAction !== null} variant="dark" size="sm">Aktivieren</Button>}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border px-3.5 py-3 sm:grid-cols-4">
                <Metric label="Restbuchwert" value={euro(selected.residualValue)} />
                <Metric label="AK" value={euro(selected.acquisitionCost)} />
                <Metric label="AfA p.a." value={euro(selected.annualDepreciation)} />
                <Metric label="Nächste AfA" value={selected.nextDepreciation} />
              </div>

              <div className="flex flex-wrap gap-1 border-t border-border px-3.5 py-2.5">
                {tabs.map((tab) => (
                  <Button
                    key={tab}
                    size="sm"
                    variant={activeTab === tab ? 'secondary' : 'ghost'}
                    aria-pressed={activeTab === tab}
                    className={activeTab === tab ? undefined : 'text-muted'}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab}
                  </Button>
                ))}
              </div>
            </Card>

            <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-2">
              <Card padding="none" className="min-w-0 overflow-hidden">
                <CardHeader as="h3" className={cardHeadClass} title={activeTab} />

                {activeTab === 'Übersicht' && (
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-2 p-3.5 text-control md:grid-flow-col md:grid-cols-2 md:grid-rows-4">
                    {([
                      ['Lieferant', formatEmptyValue(selected.supplier)],
                      ['Rechnung', formatEmptyValue(selected.invoiceRef)],
                      ['Aktivierung', selected.activationDate],
                      ['Kostenstelle', selected.costCenter],
                      ['Standort', selected.location],
                      ['Status', selectedStatus.label],
                      ['Beleg', selected.receiptLinked ? 'Verknüpft' : 'Offen'],
                      ['Nächste AfA', selected.nextDepreciation],
                    ] as const).map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-3">
                        <dt className="text-muted">{label}</dt>
                        <dd className="font-medium tabular-nums text-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {activeTab === 'Abschreibungsplan' && (
                  <>
                    {scheduleLoading ? <div className="p-3.5 text-control text-muted" role="status" aria-live="polite" aria-busy="true">Abschreibungsplan wird geladen…</div> : null}
                    {scheduleError && <div className={`m-3.5 flex flex-wrap items-center gap-3 border-error-border bg-error-bg text-error-text ${bannerClass}`} role="alert"><span>{scheduleError}</span><Button type="button" size="sm" variant="secondary" onClick={() => { if (selected) void loadScheduleForAsset(selected.id); }}>Erneut versuchen</Button></div>}
                    {!scheduleLoading && !dataAdapter ? (
                      <p className="px-3.5 py-2.5 text-caption text-warning-text" role="status">Beispieldaten: Der Abschreibungsplan ist ohne verbundenes Anlagen-Backend abgeleitet.</p>
                    ) : null}
                    {!scheduleLoading && scheduleRows.length > 0 && (
                      <Table aria-label="Abschreibungsplan" bare containerClassName={dataAdapter ? undefined : 'border-t border-border'}>
                        <TableHeader><TableRow><TableHead>Jahr</TableHead><TableHead numeric>AfA</TableHead><TableHead>Status</TableHead><TableHead numeric>RBW danach</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {scheduleRows.map((period, index, rows) => {
                            const depreciated = rows.slice(0, index + 1).reduce((sum, row) => sum + row.amount, 0);
                            return (
                              <TableRow key={period.id}>
                                <TableCell className="tabular-nums">{period.year}</TableCell>
                                <TableCell numeric>{euro(period.amount)}</TableCell>
                                <TableCell><Badge tone={period.status === 'posted' ? 'success' : 'neutral'}>{period.status === 'posted' ? 'Gebucht' : period.status === 'cancelled' ? 'Storniert' : 'Geplant'}</Badge></TableCell>
                                <TableCell numeric>{euro(Math.max(selected.acquisitionCost - depreciated, 0))}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </>
                )}

                {activeTab === 'Bewegungen' && (
                  <div className="space-y-3 p-3.5">
                    {!schedule.length && dataAdapter ? <div className="text-control text-muted">Kein Abschreibungsplan vorhanden.</div> : null}
                    <div>
                      <div className="text-label text-foreground">Zugang / Aktivierung</div>
                      <div className="mt-1 text-control text-muted">
                        {selected.activationDate} • Anschaffung <span className="tabular-nums">{euro(selected.acquisitionCost)}</span> • Status {selectedStatus.label}
                      </div>
                    </div>
                  </div>
                )}

                {!['Übersicht', 'Abschreibungsplan', 'Bewegungen'].includes(activeTab) && (
                  <EmptyState title="Für diesen Bereich liegen noch keine Daten vor." />
                )}
              </Card>

              <section className="min-w-0 space-y-3.5">
                {canMutate && dataAdapter?.runDepreciation && selected.status === 'aktiv' && (
                  <Card padding="none">
                    <form noValidate onSubmit={(event) => { event.preventDefault(); void postDepreciation(); }} aria-busy={busyAction === 'depreciation'}>
                      <CardHeader as="h3" className={cardHeadClass} title="Abschreibung buchen" subtitle="Die Buchung wird erst nach erfolgreicher Antwort in Liste und Plan übernommen." />
                      <div className="flex flex-col gap-3 p-3.5">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <Field id="asset-depreciation-year" label={requiredLabel('Geschäftsjahr')}>
                            <Input fullWidth type="number" min="2000" step="1" value={depreciationYear} onChange={(event) => setDepreciationYear(event.target.value)} required />
                          </Field>
                          <Field id="asset-depreciation-date" label={requiredLabel('Buchungsdatum')}>
                            <Input fullWidth type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} required />
                          </Field>
                        </div>
                        <Field id="asset-depreciation-reason" label={requiredLabel('Audit-Grund')}>
                          <Textarea fullWidth value={depreciationReason} onChange={(event) => setDepreciationReason(event.target.value)} required rows={2} placeholder="Warum wird die AfA jetzt gebucht?" />
                        </Field>
                      </div>
                      <div className="flex justify-end border-t border-border px-3.5 py-3">
                        <Button type="submit" disabled={busyAction !== null} variant="dark">{busyAction === 'depreciation' ? 'Buche…' : 'AfA buchen'}</Button>
                      </div>
                    </form>
                  </Card>
                )}

                {canMutate && dataAdapter?.disposeAsset && !['verkauft', 'stillgelegt'].includes(selected.status) && (
                  <Card padding="none">
                    <form noValidate onSubmit={(event) => { event.preventDefault(); void dispose(); }} aria-busy={busyAction === 'disposal'}>
                      <CardHeader as="h3" className={cardHeadClass} title="Anlage ausbuchen" subtitle="Verkaufserlös 0,00 € führt zur Stilllegung; ein Erlös führt zum Verkauf." />
                      <div className="flex flex-col gap-3 p-3.5">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <Field id="asset-disposal-date" label={requiredLabel('Ausbuchungsdatum')}>
                            <Input fullWidth type="date" value={disposalDate} onChange={(event) => setDisposalDate(event.target.value)} required />
                          </Field>
                          <Field id="asset-disposal-proceeds" label={requiredLabel('Verkaufserlös netto')}>
                            <Input fullWidth type="number" min="0" step="0.01" value={disposalProceeds} onChange={(event) => setDisposalProceeds(event.target.value)} required />
                          </Field>
                          <Field id="asset-disposal-tax-rate" label={requiredLabel('Umsatzsteuersatz')}>
                            <Select fullWidth value={disposalTaxRate} onChange={(event) => setDisposalTaxRate(event.target.value as '0' | '7' | '19')} required><option value="0">0 %</option><option value="7">7 %</option><option value="19">19 %</option></Select>
                          </Field>
                          <Input label="Erlöskonto / Zahlungskonto" fullWidth value={proceedsAccountNumber} onChange={(event) => setProceedsAccountNumber(event.target.value)} placeholder="Optional, z. B. 1200" />
                        </div>
                        <Field id="asset-disposal-reason" label={requiredLabel('Audit-Grund')}>
                          <Textarea fullWidth value={disposalReason} onChange={(event) => setDisposalReason(event.target.value)} required rows={2} placeholder="Warum wird die Anlage ausgebucht?" />
                        </Field>
                        <Checkbox label="Ich bestätige die Ausbuchung und die daraus folgende Journalbuchung." checked={disposalConfirmed} onChange={(event) => setDisposalConfirmed(event.target.checked)} />
                      </div>
                      <div className="flex justify-end border-t border-border px-3.5 py-3">
                        <Button type="submit" disabled={busyAction !== null || !disposalConfirmed} variant="dark">{busyAction === 'disposal' ? 'Buche…' : 'Ausbuchung bestätigen'}</Button>
                      </div>
                    </form>
                  </Card>
                )}

                {!dataAdapter && <Card><p className="text-control text-muted">Mutationen sind im Demo-Modus deaktiviert.</p></Card>}
                {dataAdapter && !dataAdapter.upsertAsset && !dataAdapter.runDepreciation && !dataAdapter.disposeAsset && <Card><p className="text-control text-muted">Anlagen-Mutationen sind für diese Verbindung nicht verfügbar.</p></Card>}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
