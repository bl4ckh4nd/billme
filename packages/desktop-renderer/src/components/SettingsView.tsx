import { DunningDeliveryReview } from './DunningDeliveryReview';


import React, { useState } from 'react';
import {
  Building2, Landmark, FileDigit, Scale,
  Save, AlertCircle, Megaphone, Globe, Tags, Plus, Trash2, AlertTriangle, Mail, Monitor, Moon, Sun, SunMoon, Users
} from 'lucide-react';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Input, PageHeader,
  SegmentedControl, Select, Switch, Textarea, useActionFeedback, useThemePreference, type CardHeaderProps, type ThemePreference,
} from '@billme/ui';
import { Spinner } from '../ui/components/Spinner';
import type { AppSettings, BusinessReportingProfile, DunningLevel } from '@billme/desktop-core/types';
import { getRendererRuntime, ipc } from '../runtime-api';
import { useSetSettingsMutation, useSettingsQuery } from '../hooks/useSettings';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { DunningResultModal } from '../ui/components/DunningResultModal';
import { DunningLevelPreviewModal } from '../ui/components/DunningLevelPreviewModal';
import { CliAccessSection } from './CliAccessSection';
import { TeamSection } from './TeamSection';

const canManageTeam = (): boolean => {
  const workspaces = getRendererRuntime().workspaces;
  const role = workspaces?.list.find((workspace) => workspace.tenantId === workspaces.currentTenantId)?.role;
  return role === 'owner' || role === 'admin';
};

type SettingsTab = 'company' | 'catalog' | 'finance' | 'numbers' | 'dunning' | 'legal' | 'portal' | 'system' | 'email' | 'appearance' | 'team';

const normalizeCategoryName = (value: string): string => value.trim();
const formatCount = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`;

const PROFIT_DETERMINATION_COPY: Record<BusinessReportingProfile['profitDetermination'], { label: string; hint: string }> = {
  eur: { label: 'EÜR', hint: 'Für Einzelunternehmen, GbR und Freiberufler. Erfasst wird die Zahlung.' },
  double_entry: { label: 'Doppelte Buchführung', hint: 'Für GmbH, UG und alle Buchführungspflichtigen. Soll an Haben, Bilanz und GuV.' },
};

const inferBusinessReportingProfile = (settings: AppSettings): BusinessReportingProfile => {
  if (settings.businessReportingProfile) return settings.businessReportingProfile;
  const isGmbh = /(?:GmbH|HRB)/i.test(`${settings.company.name} ${settings.finance.registerCourt}`);
  return {
    jurisdiction: 'DE',
    legalForm: isGmbh ? 'gmbh' : 'sole_proprietor',
    profitDetermination: isGmbh ? 'double_entry' : 'eur',
    hgbSizeClass: isGmbh ? 'small' : undefined,
    fiscalYearStart: '01-01',
    chart: isGmbh ? 'SKR03' : undefined,
    vatMethod: settings.legal.taxAccountingMethod ?? 'soll',
  };
};

/** One settings group: a card on the ground with a lined head. `flush` leaves the body padding to the rows. */
const SettingsCard: React.FC<Pick<CardHeaderProps, 'title' | 'subtitle' | 'count' | 'actions'> & { flush?: boolean; children: React.ReactNode }> = ({
  flush = false,
  children,
  ...head
}) => (
  <Card padding="none">
    <CardHeader className="border-b border-border px-3.5 py-3" {...head} />
    <div className={flush ? undefined : 'flex flex-col gap-3 p-3.5'}>{children}</div>
  </Card>
);

/** Per-device display preference; applies at once and is not part of "Einstellungen speichern". */
const AppearanceSettings: React.FC = () => {
  const [theme, setTheme] = useThemePreference();
  return (
    <SettingsCard title="Darstellung" subtitle="Gilt sofort und nur auf diesem Gerät. Rechnungen und PDFs bleiben immer hell.">
      <SegmentedControl<ThemePreference>
        aria-label="Farbschema"
        className="self-start"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'system', label: 'System', icon: <Monitor size={14} aria-hidden="true" /> },
          { value: 'light', label: 'Hell', icon: <Sun size={14} aria-hidden="true" /> },
          { value: 'dark', label: 'Dunkel', icon: <Moon size={14} aria-hidden="true" /> },
        ]}
      />
    </SettingsCard>
  );
};

/**
 * Settings gate. The form below seeds itself from the stored settings, so it is
 * mounted only once the query has answered: a failed query must never leave the
 * user editing (and saving) a stand-in company, bank account or tax number.
 */
export const SettingsView: React.FC = () => {
  const { data: loadedSettings, isError, refetch } = useSettingsQuery();

  // Data first: once the form is mounted, a failed background refetch must not
  // throw away edits the user is making.
  if (loadedSettings) return <SettingsForm initialSettings={loadedSettings} />;

  if (isError) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <ErrorState
          title="Einstellungen konnten nicht geladen werden"
          description="Ohne die gespeicherten Stammdaten würde das Formular leer starten und leere Daten speichern."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 text-muted">
      <Spinner size="md" />
      <p role="status" className="text-control">Einstellungen werden geladen …</p>
    </div>
  );
};

const SettingsForm: React.FC<{ initialSettings: AppSettings }> = ({ initialSettings }) => {
  const isWebShell = getRendererRuntime().shell === 'web';
  const queryClient = useQueryClient();
  // `billme login` links here with its code (`#/settings?cliCode=…`); that lands on the section that takes it.
  const [cliCode] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('cliCode') ?? undefined);
  const [activeTab, setActiveTab] = useState<SettingsTab>(cliCode ? 'system' : 'company');
  const loadedSettings = initialSettings;
  const setSettingsMutation = useSetSettingsMutation();
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [reportingProfile, setReportingProfile] = useState<BusinessReportingProfile>(() => inferBusinessReportingProfile(initialSettings));
  const [backupPath, setBackupPath] = useState('');
  const [auditStatus, setAuditStatus] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [portalApiKey, setPortalApiKey] = useState('');
  const [portalApiKeyConfigured, setPortalApiKeyConfigured] = useState(false);
  const [portalApiKeyTouched, setPortalApiKeyTouched] = useState(false);
  const [portalTestStatus, setPortalTestStatus] = useState<string | null>(null);
  const [showDunningResult, setShowDunningResult] = useState(false);
  const [dunningResult, setDunningResult] = useState<{
    processedInvoices: number;
    emailsSent: number;
    feesApplied: number;
    errors: Array<{ invoiceNumber: string; error: string }>;
  } | null>(null);
  const [dunningRunning, setDunningRunning] = useState(false);
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpPasswordConfigured, setSmtpPasswordConfigured] = useState(false);
  const [smtpPasswordTouched, setSmtpPasswordTouched] = useState(false);
  const [resendApiKey, setResendApiKey] = useState('');
  const [resendApiKeyConfigured, setResendApiKeyConfigured] = useState(false);
  const [resendApiKeyTouched, setResendApiKeyTouched] = useState(false);
  const [emailTestStatus, setEmailTestStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [emailTesting, setEmailTesting] = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewLevelIndex, setPreviewLevelIndex] = useState<number | null>(null);
  /** The choice inside the "Gewinnermittlung ändern" dialog; null while the dialog is closed. */
  const [pendingProfitDetermination, setPendingProfitDetermination] = useState<BusinessReportingProfile['profitDetermination'] | null>(null);
  const { notify } = useActionFeedback('settings');

  React.useEffect(() => {
    if (loadedSettings) {
      setSettings(loadedSettings);
      setReportingProfile(inferBusinessReportingProfile(loadedSettings));
    }
  }, [loadedSettings]);

  React.useEffect(() => {
    let cancelled = false;
    if (isWebShell) return;
    void (async () => {
      try {
        const configured = await ipc.secrets.has({ key: 'portal.apiKey' });
        if (!cancelled) setPortalApiKeyConfigured(configured);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const normalizeCategoryList = (list: Array<{ id: string; name: string }>) => {
      const seen = new Set<string>();
      const out: Array<{ id: string; name: string }> = [];
      for (const item of list) {
        const normalized = normalizeCategoryName(item.name);
        if (!normalized) continue;
        const key = normalized.toLocaleLowerCase('de-DE');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...item, name: normalized });
      }
      return out;
    };

    const prevCategories = normalizeCategoryList(loadedSettings?.catalog?.categories ?? []);
    const nextCategories = normalizeCategoryList(settings.catalog?.categories ?? []);

    const prevById = new Map(prevCategories.map((c) => [c.id, c]));
    const nextById = new Map(nextCategories.map((c) => [c.id, c]));

    const renameMap = new Map<string, string>(); // oldName -> newName
    const removedNames: string[] = [];

    for (const prev of prevCategories) {
      const next = nextById.get(prev.id);
      if (!next) {
        removedNames.push(prev.name);
        continue;
      }
      if (prev.name !== next.name) {
        renameMap.set(prev.name, next.name);
      }
    }

    const fallbackCategoryName =
      nextCategories[0]?.name?.trim() ||
      prevCategories[0]?.name?.trim() ||
      'Allgemein';
    const allowedCategoryNames = new Set(nextCategories.map((c) => c.name));

    if (renameMap.size > 0 || removedNames.length > 0 || allowedCategoryNames.size > 0) {
      const articles = await ipc.articles.list();
      let changed = 0;
      for (const a of articles) {
        const old = normalizeCategoryName(a.category);
        const renamed = renameMap.get(old);
        const moved = removedNames.includes(old) ? fallbackCategoryName : undefined;
        const categoryFromRules = renamed ?? moved ?? old;
        const nextCategory = allowedCategoryNames.has(categoryFromRules)
          ? categoryFromRules
          : fallbackCategoryName;
        if (!nextCategory || nextCategory === old) continue;
        changed++;
        await ipc.articles.upsert({ article: { ...a, category: nextCategory } });
      }
      if (changed > 0) {
        await queryClient.invalidateQueries({ queryKey: ['articles'] });
      }
    }

    const sanitizedSettings: AppSettings = {
      ...settings,
      businessReportingProfile: reportingProfile,
      legal: {
        ...settings.legal,
        taxAccountingMethod: reportingProfile.vatMethod,
      },
      catalog: {
        categories: nextCategories.length > 0
          ? nextCategories
          : [{ id: uuidv4(), name: 'Allgemein' }],
      },
    };

    setSettings(sanitizedSettings);
    await setSettingsMutation.mutateAsync(sanitizedSettings);

    const nextKey = portalApiKey.trim();
    try {
      if (!isWebShell && portalApiKeyTouched) {
        if (nextKey) {
          await ipc.secrets.set({ key: 'portal.apiKey', value: nextKey });
          setPortalApiKeyConfigured(true);
        } else {
          await ipc.secrets.delete({ key: 'portal.apiKey' });
          setPortalApiKeyConfigured(false);
        }
        setPortalApiKeyTouched(false);
      }
    } catch {
      notify('error', 'Zugangsdaten konnten nicht gespeichert werden. Bitte versuche es erneut.');
      return;
    }

    // Save email credentials to keychain
    try {
      if (!isWebShell && smtpPasswordTouched) {
        if (smtpPassword.trim()) {
          await ipc.secrets.set({ key: 'smtp.password', value: smtpPassword.trim() });
          setSmtpPasswordConfigured(true);
        } else {
          await ipc.secrets.delete({ key: 'smtp.password' });
          setSmtpPasswordConfigured(false);
        }
        setSmtpPasswordTouched(false);
      }

      if (!isWebShell && resendApiKeyTouched) {
        if (resendApiKey.trim()) {
          await ipc.secrets.set({ key: 'resend.apiKey', value: resendApiKey.trim() });
          setResendApiKeyConfigured(true);
        } else {
          await ipc.secrets.delete({ key: 'resend.apiKey' });
          setResendApiKeyConfigured(false);
        }
        setResendApiKeyTouched(false);
      }
    } catch {
      notify('error', 'Zugangsdaten konnten nicht gespeichert werden. Bitte versuche es erneut.');
      return;
    }

    notify('success', 'Einstellungen gespeichert!');
  };

  const updateNested = (section: keyof AppSettings, field: string, value: string | number | boolean) => {
    setSettings(prev => ({
      ...prev,
      [section]: {
        ...(prev[section] as Record<string, unknown>),
        [field]: value
      }
    }));
  };

  const updateReportingProfile = <K extends keyof BusinessReportingProfile>(field: K, value: BusinessReportingProfile[K]) => {
    setReportingProfile((current) => {
      if (field === 'legalForm' && value === 'gmbh') {
        return { ...current, legalForm: value, profitDetermination: 'double_entry', hgbSizeClass: current.hgbSizeClass ?? 'micro', chart: current.chart ?? 'SKR03' };
      }
      if (field === 'legalForm' && value === 'sole_proprietor') {
        return { ...current, legalForm: value, profitDetermination: 'eur', hgbSizeClass: undefined };
      }
      if (field === 'profitDetermination' && value === 'eur' && current.legalForm === 'gmbh') return current;
      return { ...current, [field]: value };
    });
  };

  const updateDunningLevel = (index: number, field: keyof DunningLevel, value: string | number | boolean) => {
      const newLevels = [...settings.dunning.levels];
      newLevels[index] = { ...newLevels[index], [field]: value };
      setSettings(prev => ({
          ...prev,
          dunning: { ...prev.dunning, levels: newLevels }
      }));
  };

  const updateAutomation = (field: string, value: string | number | boolean) => {
    setSettings(prev => ({
      ...prev,
      automation: {
        ...prev.automation,
        [field]: value
      }
    }));
  };

  // Calculate next scheduled dunning run time
  const calculateNextRun = (runTime: string): string => {
    const now = new Date();
    const [hours, minutes] = runTime.split(':').map(Number);
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.toLocaleDateString('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleManualDunningRun = async () => {
    setDunningRunning(true);
    try {
      const response = await ipc.dunning.manualRun();
      if (response.success && response.result) {
        setDunningResult(response.result);
        setShowDunningResult(true);
      } else {
        // Show error
        notify('error', 'Fehler beim Mahnlauf: ' + (response.error || 'Unbekannter Fehler'));
      }
    } catch (error) {
      notify('error', 'Fehler beim Mahnlauf: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setDunningRunning(false);
    }
  };

  const handleEmailTest = async () => {
    setEmailTesting(true);
    setEmailTestStatus(null);
    try {
      const result = await ipc.email.testConfig({
        provider: settings.email.provider as 'smtp' | 'resend',
        smtpHost: settings.email.smtpHost,
        smtpPort: settings.email.smtpPort,
        smtpSecure: settings.email.smtpSecure,
        smtpUser: settings.email.smtpUser,
        smtpPassword: smtpPassword || undefined,
        resendApiKey: resendApiKey || undefined,
      });

      setEmailTestStatus({
        success: result.success,
        message: result.success ? 'Verbindung erfolgreich.' : (result.error || 'Verbindungstest fehlgeschlagen.'),
      });
    } catch (error) {
      setEmailTestStatus({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setEmailTesting(false);
    }
  };

  // Load email credentials from keychain on mount
  React.useEffect(() => {
    if (isWebShell) return;
    (async () => {
      try {
        const [smtpConfigured, resendConfigured] = await Promise.all([
          ipc.secrets.has({ key: 'smtp.password' }),
          ipc.secrets.has({ key: 'resend.apiKey' }),
        ]);
        setSmtpPasswordConfigured(smtpConfigured);
        setResendApiKeyConfigured(resendConfigured);
      } catch {
        // ignore
      }
    })();
  }, []);

  const formatPreview = (prefix: string, counter: number, length: number) => {
    const safeCounter = Number.isFinite(counter) ? Math.max(1, Math.floor(counter)) : 1;
    const safeLength = Number.isFinite(length) ? Math.max(1, Math.floor(length)) : 3;
    return prefix.replace(/%Y/g, new Date().getFullYear().toString())
      + safeCounter.toString().padStart(safeLength, '0');
  };

  const parsePositiveInteger = (value: string, fallback: number, min = 1) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, parsed);
  };
  const nextInvoicePreview = formatPreview(
    settings.numbers.invoicePrefix,
    settings.numbers.nextInvoiceNumber,
    settings.numbers.numberLength,
  );
  const nextCustomerPreview = formatPreview(
    settings.numbers.customerPrefix,
    settings.numbers.nextCustomerNumber,
    settings.numbers.customerNumberLength,
  );

  const navGroups = [
    {
      label: 'Unternehmen',
      items: [
        { id: 'company', label: 'Stammdaten', icon: Building2, desc: 'Adresse & Kontakt' },
        { id: 'legal', label: 'Rechtliches', icon: Scale, desc: 'AGB & Steuerregeln' },
      ],
    },
    {
      label: 'Dokumente',
      items: [
        { id: 'finance', label: 'Finanzen', icon: Landmark, desc: 'Bank & Steuern' },
        { id: 'numbers', label: 'Nummernkreise', icon: FileDigit, desc: 'Rechnungs- & Kundennr.' },
        { id: 'catalog', label: 'Kategorien', icon: Tags, desc: 'Produkte & Leistungen' },
      ],
    },
    {
      label: 'Kommunikation',
      items: [
        { id: 'email', label: 'E-Mail', icon: Mail, desc: 'SMTP & Resend' },
        { id: 'dunning', label: 'Mahnwesen', icon: Megaphone, desc: 'Mahnstufen & Gebühren' },
        { id: 'portal', label: 'Portal', icon: Globe, desc: 'Angebotslinks & Sync' },
      ],
    },
    {
      label: 'System',
      items: [
        // Only a hosted server has a team (the desktop runs for one person), and only owners and admins manage it.
        ...(canManageTeam() ? [{ id: 'team', label: 'Team', icon: Users, desc: 'Mitglieder & Einladungen' }] : []),
        { id: 'system', label: 'System', icon: AlertCircle, desc: 'Backup, Audit & CLI' },
        { id: 'appearance', label: 'Darstellung', icon: SunMoon, desc: 'Hell, Dunkel, System' },
      ],
    },
  ];
  const navItems = navGroups.flatMap((g) => g.items);

  const emailTestBanner = emailTestStatus && (
    <p
      className={`rounded-control border px-3 py-2.5 text-control ${
        emailTestStatus.success
          ? 'border-success-border bg-success-bg text-success-text'
          : 'border-error-border bg-error-bg text-error-text'
      }`}
    >
      {emailTestStatus.message}
    </p>
  );

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'company':
        return (
          <SettingsCard
            title="Unternehmensdaten"
            subtitle="Diese Informationen erscheinen im Kopf- und Fußbereich der Rechnung."
          >
            <Input
              id="settings-firmenname"
              label="Firmenname"
              type="text"
              fullWidth
              value={settings.company.name}
              onChange={(e) => updateNested('company', 'name', e.target.value)}
            />
            <Input
              id="settings-inhaber-geschaftsfuhrer"
              label="Inhaber / Geschäftsführer"
              type="text"
              fullWidth
              value={settings.company.owner}
              onChange={(e) => updateNested('company', 'owner', e.target.value)}
            />
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input
                  id="settings-strae-hausnr"
                  label="Straße & Hausnr."
                  type="text"
                  fullWidth
                  value={settings.company.street}
                  onChange={(e) => updateNested('company', 'street', e.target.value)}
                />
              </div>
              <Input
                id="settings-plz"
                label="PLZ"
                type="text"
                fullWidth
                value={settings.company.zip}
                onChange={(e) => updateNested('company', 'zip', e.target.value)}
              />
            </div>
            <Input
              id="settings-stadt"
              label="Stadt"
              type="text"
              fullWidth
              value={settings.company.city}
              onChange={(e) => updateNested('company', 'city', e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                id="settings-e-mail-adresse"
                label="E-Mail Adresse"
                type="email"
                fullWidth
                value={settings.company.email}
                onChange={(e) => updateNested('company', 'email', e.target.value)}
              />
              <Input
                id="settings-telefon"
                label="Telefon"
                type="text"
                fullWidth
                value={settings.company.phone}
                onChange={(e) => updateNested('company', 'phone', e.target.value)}
              />
            </div>
            <Input
              id="settings-webseite"
              label="Webseite"
              type="text"
              fullWidth
              value={settings.company.website}
              onChange={(e) => updateNested('company', 'website', e.target.value)}
            />
          </SettingsCard>
        );
      case 'catalog':
        return (
          <SettingsCard
            title="Kategorien"
            subtitle="Kategorien für „Produkte & Leistungen“. Änderungen können beim Speichern automatisch in Artikeln übernommen werden."
            actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSettings((prev) => ({
                    ...prev,
                    catalog: {
                      categories: [
                        ...(prev.catalog?.categories ?? []),
                        { id: uuidv4(), name: 'Neu' },
                      ],
                    },
                  }));
                }}
              >
                <Plus size={14} aria-hidden="true" /> Kategorie
              </Button>
            }
          >
            {(settings.catalog?.categories ?? []).length === 0 ? (
              <EmptyState
                title="Noch keine Kategorien"
                description="Lege Kategorien an, damit du sie bei Artikeln auswählen kannst."
              />
            ) : (
              (settings.catalog?.categories ?? []).map((cat, idx) => (
                <div key={cat.id} className="flex items-end gap-3">
                  <span className="grid size-8.5 shrink-0 place-items-center rounded-control bg-surface-sunken text-caption font-medium tabular-nums text-muted">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Input
                      label="Name"
                      fullWidth
                      value={cat.name}
                      onChange={(e) => {
                        const name = e.target.value;
                        setSettings((prev) => {
                          const list = [...(prev.catalog?.categories ?? [])];
                          list[idx] = { ...list[idx]!, name };
                          return { ...prev, catalog: { categories: list } };
                        });
                      }}
                    />
                  </div>
                  <IconButton
                    aria-label={`Kategorie ${cat.name} entfernen`}
                    onClick={() => {
                      setSettings((prev) => {
                        const list = (prev.catalog?.categories ?? []).filter((c) => c.id !== cat.id);
                        return { ...prev, catalog: { categories: list } };
                      });
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </IconButton>
                </div>
              ))
            )}
          </SettingsCard>
        );
      case 'finance':
        return (
          <SettingsCard
            title="Bankverbindung & Steuer"
            subtitle="Wichtig für den Zahlungsverkehr und die Pflichtangaben auf der Rechnung."
          >
            <h3 className="text-label text-foreground">Bankkonto</h3>
            <Input
              id="settingsview-bankname"
              label="Bankname"
              type="text"
              fullWidth
              value={settings.finance.bankName}
              onChange={(e) => updateNested('finance', 'bankName', e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                id="settingsview-iban"
                label="IBAN"
                type="text"
                fullWidth
                className="font-mono"
                value={settings.finance.iban}
                onChange={(e) => updateNested('finance', 'iban', e.target.value)}
              />
              <Input
                id="settingsview-bic"
                label="BIC"
                type="text"
                fullWidth
                className="font-mono"
                value={settings.finance.bic}
                onChange={(e) => updateNested('finance', 'bic', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
              <Input
                id="settings-steuernummer"
                label="Steuernummer"
                type="text"
                fullWidth
                value={settings.finance.taxId}
                onChange={(e) => updateNested('finance', 'taxId', e.target.value)}
              />
              <Input
                id="settings-ust-idnr"
                label="USt-IdNr."
                type="text"
                fullWidth
                value={settings.finance.vatId}
                onChange={(e) => updateNested('finance', 'vatId', e.target.value)}
              />
            </div>
            <Input
              id="settings-registergericht-hrb"
              label="Registergericht / HRB"
              type="text"
              fullWidth
              value={settings.finance.registerCourt}
              onChange={(e) => updateNested('finance', 'registerCourt', e.target.value)}
              placeholder="z.B. Amtsgericht Berlin HRB 12345"
            />
          </SettingsCard>
        );
      case 'numbers':
        return (
          <SettingsCard
            title="Nummernkreise"
            subtitle="Definieren Sie das Format für Ihre Rechnungs-, Angebots- und Kundennummern."
          >
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-label text-foreground">Rechnungen</h3>
                <p className="text-caption text-muted">
                  Vorschau: <span className="font-mono text-foreground">{nextInvoicePreview}</span>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Präfix Format"
                  type="text"
                  fullWidth
                  className="font-mono"
                  hint="%Y = Aktuelles Jahr (z.B. 2023)"
                  value={settings.numbers.invoicePrefix}
                  onChange={(e) => updateNested('numbers', 'invoicePrefix', e.target.value)}
                />
                <Input
                  id="settings-nachste-nummer"
                  label="Nächste Nummer"
                  type="number"
                  fullWidth
                  className="tabular-nums"
                  value={settings.numbers.nextInvoiceNumber}
                  min={1}
                  onChange={(e) => updateNested(
                    'numbers',
                    'nextInvoiceNumber',
                    parsePositiveInteger(e.target.value, settings.numbers.nextInvoiceNumber),
                  )}
                />
              </div>
              <div>
                {/* ponytail: raw range inputs here and under Kunden; @billme/ui has no slider, replace when one exists. */}
                <Field id="settings-mindestlange-padding" label="Mindestlänge (Padding)">
                  <input
                    type="range"
                    min="1"
                    max="6"
                    step="1"
                    value={settings.numbers.numberLength}
                    onChange={(e) => updateNested(
                      'numbers',
                      'numberLength',
                      parsePositiveInteger(e.target.value, settings.numbers.numberLength),
                    )}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground"
                  />
                </Field>
                <div className="mt-1 flex justify-between text-micro text-muted">
                  <span>1</span>
                  <span className="tabular-nums">{settings.numbers.numberLength} Stellen (z.B. 001)</span>
                  <span>6</span>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-3 border-t border-border pt-3">
              <h3 className="text-label text-foreground">Angebote</h3>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  id="settings-prafix-format"
                  label="Präfix Format"
                  type="text"
                  fullWidth
                  className="font-mono"
                  value={settings.numbers.offerPrefix}
                  onChange={(e) => updateNested('numbers', 'offerPrefix', e.target.value)}
                />
                <Input
                  id="settings-nachste-nummer-2"
                  label="Nächste Nummer"
                  type="number"
                  fullWidth
                  className="tabular-nums"
                  value={settings.numbers.nextOfferNumber}
                  min={1}
                  onChange={(e) => updateNested(
                    'numbers',
                    'nextOfferNumber',
                    parsePositiveInteger(e.target.value, settings.numbers.nextOfferNumber),
                  )}
                />
              </div>
            </section>

            <section className="flex flex-col gap-3 border-t border-border pt-3">
              <h3 className="text-label text-foreground">Auftragsbestätigungen</h3>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  id="settings-ab-prefix"
                  label="Präfix Format"
                  type="text"
                  fullWidth
                  className="font-mono"
                  value={settings.numbers.orderConfirmationPrefix ?? 'AB-%Y-'}
                  onChange={(e) => updateNested('numbers', 'orderConfirmationPrefix', e.target.value)}
                />
                <Input
                  id="settings-ab-next"
                  label="Nächste Nummer"
                  type="number"
                  fullWidth
                  className="tabular-nums"
                  value={settings.numbers.nextOrderConfirmationNumber ?? 1}
                  min={1}
                  onChange={(e) => updateNested(
                    'numbers',
                    'nextOrderConfirmationNumber',
                    parsePositiveInteger(e.target.value, settings.numbers.nextOrderConfirmationNumber ?? 1),
                  )}
                />
              </div>
            </section>

            <section className="flex flex-col gap-3 border-t border-border pt-3">
              <h3 className="text-label text-foreground">Lieferscheine</h3>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  id="settings-ls-prefix"
                  label="Präfix Format"
                  type="text"
                  fullWidth
                  className="font-mono"
                  value={settings.numbers.deliveryNotePrefix ?? 'LS-%Y-'}
                  onChange={(e) => updateNested('numbers', 'deliveryNotePrefix', e.target.value)}
                />
                <Input
                  id="settings-ls-next"
                  label="Nächste Nummer"
                  type="number"
                  fullWidth
                  className="tabular-nums"
                  value={settings.numbers.nextDeliveryNoteNumber ?? 1}
                  min={1}
                  onChange={(e) => updateNested(
                    'numbers',
                    'nextDeliveryNoteNumber',
                    parsePositiveInteger(e.target.value, settings.numbers.nextDeliveryNoteNumber ?? 1),
                  )}
                />
              </div>
            </section>

            <section className="flex flex-col gap-3 border-t border-border pt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-label text-foreground">Kunden</h3>
                <p className="text-caption text-muted">
                  Vorschau: <span className="font-mono text-foreground">{nextCustomerPreview}</span>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  id="settings-prafix-format-2"
                  label="Präfix Format"
                  type="text"
                  fullWidth
                  className="font-mono"
                  value={settings.numbers.customerPrefix}
                  onChange={(e) => updateNested('numbers', 'customerPrefix', e.target.value)}
                />
                <Input
                  id="settings-nachste-nummer-3"
                  label="Nächste Nummer"
                  type="number"
                  fullWidth
                  className="tabular-nums"
                  value={settings.numbers.nextCustomerNumber}
                  min={1}
                  onChange={(e) => updateNested(
                    'numbers',
                    'nextCustomerNumber',
                    parsePositiveInteger(e.target.value, settings.numbers.nextCustomerNumber),
                  )}
                />
              </div>
              <div>
                <Field id="settings-mindestlange-padding-2" label="Mindestlänge (Padding)">
                  <input
                    type="range"
                    min="1"
                    max="8"
                    step="1"
                    value={settings.numbers.customerNumberLength}
                    onChange={(e) => updateNested(
                      'numbers',
                      'customerNumberLength',
                      parsePositiveInteger(e.target.value, settings.numbers.customerNumberLength),
                    )}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground"
                  />
                </Field>
                <div className="mt-1 flex justify-between text-micro text-muted">
                  <span>1</span>
                  <span className="tabular-nums">{settings.numbers.customerNumberLength} Stellen (z.B. 0001)</span>
                  <span>8</span>
                </div>
              </div>
            </section>
          </SettingsCard>
        );
      case 'email':
        if (isWebShell) return <SettingsCard title="E-Mail im Serverbetrieb" subtitle="Versandanbieter und Zugangsdaten werden vom Betreiber am Server eingerichtet.">
          <p className="text-control">Gespeicherter Anbieter: {settings.email.provider}. Der Verbindungstest verwendet die Serverkonfiguration.</p>
          <Button className="mt-3" variant="secondary" loading={emailTesting} onClick={handleEmailTest}>Serververbindung prüfen</Button>
          {emailTestStatus && <p role="status" className="mt-3 text-control">{emailTestStatus.message}</p>}
        </SettingsCard>;
        return (
          <>
            <SettingsCard
              title="E-Mail Konfiguration"
              subtitle="Konfigurieren Sie SMTP oder Resend für den E-Mail-Versand."
            >
              <h3 className="text-caption font-medium text-foreground-secondary">E-Mail-Anbieter</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {([
                  { id: 'none', label: 'Kein Versand', hint: 'E-Mails deaktiviert' },
                  { id: 'smtp', label: 'SMTP', hint: 'Eigener Mail-Server' },
                  { id: 'resend', label: 'Resend', hint: 'Transactional API' },
                ] as const).map((provider) => {
                  const active = settings.email.provider === provider.id;
                  return (
                    // ponytail: raw button; the prototype's option card (viewEinstellungen, Buchführung) has no primitive, replace when @billme/ui gets one.
                    <button
                      type="button"
                      key={provider.id}
                      aria-pressed={active}
                      onClick={() => updateNested('email', 'provider', provider.id)}
                      className={`rounded-card border bg-surface p-3 text-left transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                        active ? 'border-foreground' : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-label text-foreground">{provider.label}</span>
                        {active && <span aria-hidden="true"><Badge tone="accent">aktiv</Badge></span>}
                      </span>
                      <span className="mt-1 block text-caption text-muted">{provider.hint}</span>
                    </button>
                  );
                })}
              </div>
            </SettingsCard>

            {settings.email.provider === 'smtp' && (
              <SettingsCard title="SMTP-Konfiguration">
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    id="settingsview-server-host"
                    label="Server (Host)"
                    type="text"
                    fullWidth
                    value={settings.email.smtpHost}
                    onChange={(e) => updateNested('email', 'smtpHost', e.target.value)}
                    placeholder="smtp.example.com"
                  />
                  <Input
                    id="settingsview-port"
                    label="Port"
                    type="number"
                    fullWidth
                    value={settings.email.smtpPort}
                    onChange={(e) => updateNested('email', 'smtpPort', Number(e.target.value))}
                    placeholder="587"
                  />
                </div>
                <Checkbox
                  label="SSL/TLS verwenden (empfohlen für Port 465)"
                  checked={settings.email.smtpSecure}
                  onChange={(e) => updateNested('email', 'smtpSecure', e.target.checked)}
                />
                <Input
                  id="settingsview-benutzername"
                  label="Benutzername"
                  type="text"
                  fullWidth
                  value={settings.email.smtpUser}
                  onChange={(e) => updateNested('email', 'smtpUser', e.target.value)}
                  placeholder="user@example.com"
                />
                <Input
                  id="settingsview-passwort"
                  label="Passwort"
                  type="password"
                  fullWidth
                  value={smtpPassword}
                  onChange={(e) => {
                    setSmtpPassword(e.target.value);
                    setSmtpPasswordTouched(true);
                  }}
                  placeholder={smtpPasswordConfigured ? '•••••••• (gespeichert)' : '••••••••'}
                  hint="Wird sicher im Schlüsselbund des Systems gespeichert."
                />
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={handleEmailTest}
                  loading={emailTesting}
                  disabled={
                    !settings.email.smtpHost ||
                    !settings.email.smtpUser ||
                    (!smtpPassword && !smtpPasswordConfigured)
                  }
                >
                  Verbindung testen
                </Button>
                {emailTestBanner}
              </SettingsCard>
            )}

            {settings.email.provider === 'resend' && (
              <SettingsCard title="Resend API-Konfiguration">
                <Input
                  id="settingsview-api-key"
                  label="API-Key"
                  type="password"
                  fullWidth
                  value={resendApiKey}
                  onChange={(e) => {
                    setResendApiKey(e.target.value);
                    setResendApiKeyTouched(true);
                    // Real-time format validation
                    if (e.target.value && !e.target.value.startsWith('re_')) {
                      setEmailTestStatus({
                        success: false,
                        message: 'Warnung: Resend API-Keys beginnen üblicherweise mit "re_"',
                      });
                    } else {
                      setEmailTestStatus(null);
                    }
                  }}
                  placeholder={resendApiKeyConfigured ? 're_*** (gespeichert)' : 're_***'}
                  hint="Wird sicher im Schlüsselbund des Systems gespeichert."
                />
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={handleEmailTest}
                  loading={emailTesting}
                  disabled={!resendApiKey && !resendApiKeyConfigured}
                >
                  API-Schlüssel testen
                </Button>
                {emailTestBanner}
              </SettingsCard>
            )}

            {settings.email.provider !== 'none' && (
              <SettingsCard title="Absender-Informationen">
                <Input
                  id="settingsview-absender-name"
                  label="Absender-Name"
                  type="text"
                  fullWidth
                  value={settings.email.fromName}
                  onChange={(e) => updateNested('email', 'fromName', e.target.value)}
                  placeholder={settings.company.name || 'Meine Firma'}
                />
                <Input
                  id="settingsview-absender-e-mail"
                  label="Absender-E-Mail"
                  type="email"
                  fullWidth
                  value={settings.email.fromEmail}
                  onChange={(e) => updateNested('email', 'fromEmail', e.target.value)}
                  placeholder={settings.company.email || 'info@example.com'}
                />
              </SettingsCard>
            )}
          </>
        );
      case 'dunning': {
        const dunningEnabled = settings.automation?.dunningEnabled ?? false;
        const activeLevelCount = settings.dunning.levels.filter(l => l.enabled).length;
        const totalLevels = settings.dunning.levels.length;

        return (
          <>
            <SettingsCard title="Mahnwesen" subtitle="Automatische Zahlungserinnerungen und Mahnungen">
              <Switch
                label="Mahnwesen aktivieren"
                description="Automatische Zahlungserinnerungen für überfällige Rechnungen"
                checked={dunningEnabled}
                onCheckedChange={(checked) => updateAutomation('dunningEnabled', checked)}
              />
              {dunningEnabled && settings.email.provider === 'none' && (
                <div className="flex items-start gap-2.5 rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text">
                  <AlertTriangle size={16} className="mt-px shrink-0" aria-hidden="true" />
                  <div>
                    <p className="font-semibold">E-Mail-Provider erforderlich</p>
                    <p>Konfigurieren Sie SMTP oder Resend im E-Mail-Tab, um Mahnungen versenden zu können.</p>
                  </div>
                </div>
              )}
              {!dunningEnabled && (
                <p className="text-caption text-muted">Aktivieren Sie das Mahnwesen, um Mahnstufen zu konfigurieren</p>
              )}
            </SettingsCard>

            {dunningEnabled && (
              <SettingsCard title="Automatisierung">
                <Input
                  id="settings-tagliche-ausfuhrung-um"
                  label="Tägliche Ausführung um"
                  type="time"
                  className="w-48"
                  value={settings.automation?.dunningRunTime ?? '09:00'}
                  onChange={(e) => updateAutomation('dunningRunTime', e.target.value)}
                />
                <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.75 text-control text-foreground">
                  <dt className="text-caption text-muted">Letzter Lauf</dt>
                  <dd>
                    {settings.automation?.lastDunningRun
                      ? new Date(settings.automation.lastDunningRun).toLocaleDateString('de-DE', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        })
                      : 'Noch nie'}
                  </dd>
                  <dt className="text-caption text-muted">Nächster Lauf</dt>
                  <dd>{calculateNextRun(settings.automation?.dunningRunTime ?? '09:00')}</dd>
                </dl>
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={handleManualDunningRun}
                  loading={dunningRunning}
                  disabled={settings.email.provider === 'none' || activeLevelCount === 0}
                >
                  <Megaphone size={16} aria-hidden="true" />
                  Jetzt manuell ausführen
                </Button>
              </SettingsCard>
            )}

            <DunningDeliveryReview />
            {dunningEnabled && (
              <SettingsCard title="Mahnstufen" count={<span className="tabular-nums">{activeLevelCount} von {totalLevels} aktiv</span>} flush>
                {settings.dunning.levels.map((level, index) => (
                  <div key={level.id} className="flex flex-col gap-3 border-b border-border p-3.5 last:border-b-0">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <Checkbox
                          checked={level.enabled}
                          aria-label={`Mahnstufe ${level.id} aktivieren`}
                          onChange={(e) => updateDunningLevel(index, 'enabled', e.target.checked)}
                        />
                        <Badge tone={level.enabled ? 'inverse' : 'neutral'}>{level.id}</Badge>
                        <h3 className="text-label text-foreground">{level.name}</h3>
                      </div>

                      <div className="flex items-center gap-3 text-caption text-muted">
                        <div className="flex items-center gap-1.5">
                          <span>nach</span>
                          <Input
                            type="number"
                            className="w-14 text-center"
                            aria-label={`${level.name}: Tage nach Fälligkeit`}
                            value={level.daysAfterDueDate}
                            onChange={(e) => updateDunningLevel(index, 'daysAfterDueDate', Number(e.target.value))}
                            disabled={!level.enabled}
                          />
                          <span>Tagen</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span>Gebühr</span>
                          <Input
                            type="number"
                            step="0.01"
                            className="w-16 text-center"
                            aria-label={`${level.name}: Gebühr in Euro`}
                            value={level.fee}
                            onChange={(e) => updateDunningLevel(index, 'fee', Number(e.target.value))}
                            disabled={!level.enabled}
                          />
                          <span>€</span>
                        </div>
                      </div>
                    </div>

                    {level.enabled && (
                      <>
                        <Input
                          label="Betreff"
                          type="text"
                          fullWidth
                          value={level.subject}
                          onChange={(e) => updateDunningLevel(index, 'subject', e.target.value)}
                          placeholder="z.B. Zahlungserinnerung für Rechnung %N"
                        />
                        <Textarea
                          label="Einleitungstext"
                          rows={2}
                          fullWidth
                          value={level.text}
                          onChange={(e) => updateDunningLevel(index, 'text', e.target.value)}
                          placeholder="z.B. leider haben wir noch keinen Zahlungseingang für die Rechnung %N vom %D über %A erhalten..."
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap gap-1">
                            {[
                              { code: '%N', label: 'Nr.', present: level.text.includes('%N') },
                              { code: '%D', label: 'Datum', present: level.text.includes('%D') },
                              { code: '%A', label: 'Betrag', present: level.text.includes('%A') },
                              { code: '%C', label: 'Kunde', present: level.text.includes('%C') },
                            ].map((ph) => (
                              <Button
                                key={ph.code}
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  const textarea = document.querySelector(`textarea[value="${level.text}"]`) as HTMLTextAreaElement;
                                  if (textarea) {
                                    const start = textarea.selectionStart;
                                    const end = textarea.selectionEnd;
                                    const newText = level.text.substring(0, start) + ph.code + level.text.substring(end);
                                    updateDunningLevel(index, 'text', newText);
                                    setTimeout(() => {
                                      textarea.focus();
                                      textarea.setSelectionRange(start + ph.code.length, start + ph.code.length);
                                    }, 0);
                                  }
                                }}
                                className={`font-mono ${ph.present ? 'border-success-border bg-success-bg text-success-text' : ''}`}
                                aria-label={`${ph.label} einfügen`}
                              >
                                {ph.code}
                              </Button>
                            ))}
                          </div>
                          <div className="flex items-center gap-2">
                            {(!level.text.includes('%N') || !level.text.includes('%A')) && (
                              <span className="inline-flex items-center gap-1 text-caption text-warning-text">
                                <AlertTriangle size={12} aria-hidden="true" />
                                %N und %A empfohlen
                              </span>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setPreviewLevelIndex(index);
                                setPreviewModalOpen(true);
                              }}
                            >
                              Vorschau
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </SettingsCard>
            )}

            <SettingsCard title="Automatische Abo-Rechnungen" subtitle="Automatische Generierung wiederkehrender Rechnungen">
              <Switch
                label="Automatische Generierung aktivieren"
                description="Abo-Rechnungen werden automatisch zum festgelegten Zeitpunkt erstellt"
                checked={settings.automation.recurringEnabled}
                onCheckedChange={(checked) => updateAutomation('recurringEnabled', checked)}
              />
              {settings.automation.recurringEnabled && (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                  <h3 className="text-label text-foreground">Automatisierung</h3>
                  <Input
                    id="settings-tagliche-ausfuhrung-um-2"
                    label="Tägliche Ausführung um"
                    type="time"
                    className="w-48"
                    value={settings.automation?.recurringRunTime ?? '03:00'}
                    onChange={(e) => updateAutomation('recurringRunTime', e.target.value)}
                    hint="Empfohlen: 03:00 Uhr (nachts, um Konflikte mit Mahnlauf zu vermeiden)"
                  />
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.75 text-control text-foreground">
                    <dt className="text-caption text-muted">Letzter Lauf</dt>
                    <dd>
                      {settings.automation?.lastRecurringRun
                        ? new Date(settings.automation.lastRecurringRun).toLocaleDateString('de-DE', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : 'Noch nie'}
                    </dd>
                    <dt className="text-caption text-muted">Nächster Lauf</dt>
                    <dd>{calculateNextRun(settings.automation?.recurringRunTime ?? '03:00')}</dd>
                  </dl>
                </div>
              )}
            </SettingsCard>
          </>
        );
      }
      case 'legal':
        return (
          <>
            <SettingsCard title="Rechtliches & Texte" subtitle="Steuerliche Einstellungen und Standardtexte.">
              <Switch
                label="Kleinunternehmerregelung anwenden"
                description="Keine Umsatzsteuerberechnung gem. § 19 UStG."
                checked={settings.legal.smallBusinessRule}
                onCheckedChange={(checked) => updateNested('legal', 'smallBusinessRule', checked)}
              />
              <Switch
                label="ZUGFeRD Export für Rechnungen aktivieren"
                description={`Exportiert Rechnungen als ZUGFeRD EN16931 (Profil ${settings.eInvoice.profile}, Version ${settings.eInvoice.version}).`}
                checked={settings.eInvoice.enabled}
                onCheckedChange={(checked) => updateNested('eInvoice', 'enabled', checked)}
              />
              <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                <Select
                  id="settings-sitzland-des-verkaufers"
                  label="Sitzland des Verkäufers"
                  fullWidth
                  value={settings.legal.countryCode ?? 'DE'}
                  onChange={(e) => updateNested('legal', 'countryCode', e.target.value)}
                >
                  <option value="DE">Deutschland</option>
                  <option value="AT">Österreich</option>
                  <option value="CH">Schweiz</option>
                </Select>
                <Input
                  id="settings-standard-umsatzsteuer"
                  label="Standard Umsatzsteuer (%)"
                  type="number"
                  fullWidth
                  value={settings.legal.defaultVatRate}
                  disabled={settings.legal.smallBusinessRule}
                  onChange={(e) => updateNested('legal', 'defaultVatRate', parseFloat(e.target.value))}
                />
                <Input
                  id="settings-zahlungsziel-tage"
                  label="Zahlungsziel (Tage)"
                  type="number"
                  fullWidth
                  value={settings.legal.paymentTermsDays}
                  onChange={(e) => updateNested('legal', 'paymentTermsDays', parseInt(e.target.value))}
                />
              </div>
            </SettingsCard>

            <SettingsCard
              title="Berichtsprofil"
              subtitle="Der aktuelle Berichts- und Steuerumfang unterstützt Deutschland. AT/CH-Berichte sind noch nicht verfügbar."
            >
              <div className="grid grid-cols-2 gap-3">
                <Select label="Rechtsraum" aria-label="Rechtsraum" fullWidth value={reportingProfile.jurisdiction} onChange={(event) => updateReportingProfile('jurisdiction', event.target.value as 'DE')}>
                  <option value="DE">Deutschland</option>
                </Select>
                <Select label="Rechtsform" aria-label="Rechtsform" fullWidth value={reportingProfile.legalForm} onChange={(event) => updateReportingProfile('legalForm', event.target.value as BusinessReportingProfile['legalForm'])}>
                  <option value="sole_proprietor">Einzelunternehmen</option>
                  <option value="gmbh">GmbH</option>
                </Select>
                <div className="col-span-2">
                  <p className="mb-1 text-caption font-medium text-foreground-secondary">Gewinnermittlung</p>
                  <div className="flex items-start justify-between gap-3 rounded-control border border-border bg-surface-muted p-3">
                    <div className="min-w-0">
                      <p data-testid="profit-determination-value" className="text-label text-foreground">{PROFIT_DETERMINATION_COPY[reportingProfile.profitDetermination].label}</p>
                      <p className="mt-0.5 text-caption text-muted">{PROFIT_DETERMINATION_COPY[reportingProfile.profitDetermination].hint}</p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => setPendingProfitDetermination(reportingProfile.profitDetermination)}>
                      Ändern…
                    </Button>
                  </div>
                </div>
                {reportingProfile.legalForm === 'gmbh' && (
                  <Select label="GmbH-Größe" aria-label="GmbH-Größe" fullWidth value={reportingProfile.hgbSizeClass ?? ''} onChange={(event) => updateReportingProfile('hgbSizeClass', event.target.value as 'micro' | 'small')}>
                    <option value="micro">Micro</option>
                    <option value="small">Small</option>
                  </Select>
                )}
                {reportingProfile.profitDetermination === 'double_entry' && (
                  <Select label="Kontenrahmen" aria-label="Kontenrahmen" fullWidth value={reportingProfile.chart ?? ''} onChange={(event) => updateReportingProfile('chart', event.target.value as 'SKR03' | 'SKR04')}>
                    <option value="SKR03">SKR03</option>
                    <option value="SKR04">SKR04</option>
                  </Select>
                )}
                <Input label="Wirtschaftsjahresbeginn (MM-TT)" aria-label="Wirtschaftsjahresbeginn" fullWidth value={reportingProfile.fiscalYearStart} onChange={(event) => updateReportingProfile('fiscalYearStart', event.target.value)} placeholder="01-01" />
                <Select label="Umsatzsteuer-Methode" aria-label="Umsatzsteuer-Methode" fullWidth value={reportingProfile.vatMethod} onChange={(event) => updateReportingProfile('vatMethod', event.target.value as BusinessReportingProfile['vatMethod'])}>
                  <option value="soll">Soll-Versteuerung</option>
                  <option value="ist">Ist-Versteuerung</option>
                </Select>
              </div>
              {reportingProfile.legalForm === 'gmbh' && reportingProfile.profitDetermination !== 'double_entry' && <p className="text-caption text-error-text">Eine GmbH muss mit doppelter Buchführung geführt werden.</p>}
            </SettingsCard>

            <SettingsCard
              title="Umsatzsteuer-Basis (Übersicht)"
              subtitle="Soll: basiert auf gestellten Rechnungen (Status ≠ Entwurf) nach Rechnungsdatum. Ist: basiert auf erfassten Zahlungen nach Zahlungsdatum."
            >
              <SegmentedControl
                aria-label="Umsatzsteuer-Basis"
                className="self-start"
                value={settings.legal.taxAccountingMethod ?? 'soll'}
                onChange={(method) => updateNested('legal', 'taxAccountingMethod', method)}
                options={[
                  { value: 'soll', label: 'Soll' },
                  { value: 'ist', label: 'Ist' },
                ]}
              />
              <p className="text-caption text-muted">
                Ein Wechsel gilt ab dem laufenden Monat; frühere Zeiträume bleiben bei der bisherigen Methode.
                {settings.legal.taxAccountingMethodSince && settings.legal.previousTaxAccountingMethod
                  ? ` Aktuell: ${settings.legal.taxAccountingMethod === 'ist' ? 'Ist' : 'Soll'} seit ${new Date(`${settings.legal.taxAccountingMethodSince}T00:00:00`).toLocaleDateString('de-DE')}, davor ${settings.legal.previousTaxAccountingMethod === 'ist' ? 'Ist' : 'Soll'}.`
                  : ''}
              </p>
            </SettingsCard>

            <SettingsCard title="Standardtexte">
              <Textarea
                id="settings-einleitungstext-standard"
                label="Einleitungstext (Standard)"
                fullWidth
                rows={3}
                value={settings.legal.defaultIntroText}
                onChange={(e) => updateNested('legal', 'defaultIntroText', e.target.value)}
              />
              <Textarea
                id="settings-fuzeilentext-zusatz"
                label="Fußzeilentext (Zusatz)"
                fullWidth
                rows={2}
                value={settings.legal.defaultFooterText}
                onChange={(e) => updateNested('legal', 'defaultFooterText', e.target.value)}
              />
            </SettingsCard>
          </>
        );
      case 'portal':
        return (
          <SettingsCard title="Angebotsportal" subtitle="Angebotslinks veröffentlichen und Status synchronisieren.">
            <Input
              id="settings-portal-basis-url"
              label="Portal-Basis-URL"
              type="text"
              fullWidth
              value={settings.portal.baseUrl}
              onChange={(e) => updateNested('portal', 'baseUrl', e.target.value)}
              placeholder="https://offers.example.com"
              hint={<>Tipp: Einrichtungsseite im Portal: <span className="font-mono">/admin/setup</span></>}
            />
            {isWebShell ? <p className="my-3 text-control text-muted">Der Publish-Schlüssel wird am Server vom Betreiber eingerichtet.</p> : <Input
              id="settings-publish-api-schlussel-optional"
              label="Publish-API-Schlüssel (optional)"
              type="password"
              fullWidth
              value={portalApiKey}
              onChange={(e) => {
                setPortalApiKey(e.target.value);
                setPortalApiKeyTouched(true);
              }}
              placeholder={
                portalApiKeyConfigured
                  ? '(im System-Schlüsselbund gespeichert, zum Ersetzen eingeben)'
                  : '(im System-Schlüsselbund gespeichert)'
              }
            />}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    setPortalTestStatus('Verbindung wird geprüft ...');
                    const baseUrl = settings.portal.baseUrl.trim();
                    if (!baseUrl) throw new Error('Portal-Basis-URL fehlt.');
                    const res = await ipc.portal.health({ baseUrl });
                    setPortalTestStatus(res.ok ? `OK (${res.ts})` : 'Fehler');
                  } catch (e) {
                    setPortalTestStatus(`Fehler: ${String(e)}`);
                  }
                }}
              >
                Verbindung testen
              </Button>
              <div className="min-w-0 flex-1 text-control text-muted">
                {portalTestStatus}
              </div>
            </div>
          </SettingsCard>
        );
      case 'appearance':
        return <AppearanceSettings />;
      case 'team':
        return <TeamSection />;
      case 'system':
        return (
          <>
            <CliAccessSection initialCode={cliCode} />

            <SettingsCard title="Audit" subtitle="Audit-Log prüfen und als CSV exportieren.">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    setAuditStatus('Audit-Log wird geprüft ...');
                    try {
                      const result = await ipc.audit.verify();
                      const errorCount = result.errors.length;
                      setAuditStatus(
                        result.ok && errorCount === 0
                          ? `Audit-Log ist intakt: ${formatCount(result.count, 'Eintrag', 'Einträge')} geprüft, keine Fehler.`
                          : `Audit-Log ist nicht intakt: ${formatCount(result.count, 'Eintrag', 'Einträge')} geprüft, ${formatCount(errorCount, 'Fehler', 'Fehler')} gefunden.`,
                      );
                    } catch (e) {
                      setAuditStatus(`Audit-Log-Prüfung fehlgeschlagen: ${e instanceof Error ? e.message : 'Unbekannter Fehler.'}`);
                    }
                  }}
                >
                  Prüfen
                </Button>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    setAuditStatus('Audit-Log wird exportiert ...');
                    try {
                      const csv = await ipc.audit.exportCsv();
                      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                      setAuditStatus('Audit-Log als CSV exportiert.');
                    } catch (e) {
                      setAuditStatus(`CSV-Export fehlgeschlagen: ${e instanceof Error ? e.message : 'Unbekannter Fehler.'}`);
                    }
                  }}
                >
                  CSV exportieren
                </Button>
              </div>
              {auditStatus && <p className="text-control text-muted">{auditStatus}</p>}
            </SettingsCard>

            {isWebShell ? <SettingsCard title="Datensicherung im Serverbetrieb"><p className="text-control">Der Betreiber sichert die Serverdatenbank und Originalbelege. Wiederherstellungen werden am Server durchgeführt.</p></SettingsCard> : <SettingsCard title="Backup" subtitle="Datenbank sichern oder aus einer Sicherung wiederherstellen.">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    setBackupStatus('Backup wird erstellt ...');
                    try {
                      const res = await ipc.db.backup();
                      setBackupStatus(`Backup erstellt. Pfad: ${res.path}`);
                    } catch (e) {
                      setBackupStatus(`Backup fehlgeschlagen: ${e instanceof Error ? e.message : 'Unbekannter Fehler.'}`);
                    }
                  }}
                >
                  Backup erstellen
                </Button>
                <div className="min-w-48 flex-1">
                  <Input
                    fullWidth
                    value={backupPath}
                    onChange={(e) => setBackupPath(e.target.value)}
                    placeholder="Pfad zur .pglite.tar-Sicherung..."
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    setBackupStatus('Wiederherstellung wird durchgeführt ...');
                    try {
                      const res = await ipc.db.restore({ path: backupPath.trim() });
                      const errorCount = res.verification.errors.length;
                      const verificationStatus = res.verification.ok && errorCount === 0
                        ? `Audit-Log geprüft: ${formatCount(res.verification.count, 'Eintrag', 'Einträge')}, keine Fehler.`
                        : `Audit-Log geprüft: ${formatCount(res.verification.count, 'Eintrag', 'Einträge')}, ${formatCount(errorCount, 'Fehler', 'Fehler')} gefunden.`;
                      setBackupStatus(`Wiederherstellung abgeschlossen: ${res.ok ? 'erfolgreich.' : 'mit Fehlern.'} ${verificationStatus}`);
                    } catch (e) {
                      setBackupStatus(`Wiederherstellung fehlgeschlagen: ${e instanceof Error ? e.message : 'Unbekannter Fehler.'}`);
                    }
                  }}
                >
                  Wiederherstellen
                </Button>
              </div>
              {backupStatus && <p className="text-control text-muted">{backupStatus}</p>}
            </SettingsCard>}
          </>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <PageHeader
        title="Einstellungen"
        actions={
          <Button onClick={handleSave} loading={setSettingsMutation.isPending}>
            <Save size={16} aria-hidden="true" />
            Einstellungen speichern
          </Button>
        }
      />
      <div className="relative flex h-full gap-3.5 overflow-hidden">

        {/* Sidebar Navigation. The page is capped at the content height, so the
            tabs can outgrow it; the sidebar owns that overflow. */}
        <div className="flex max-h-full w-56 shrink-0 flex-col self-start overflow-y-auto rounded-card border border-border bg-surface p-2.5">
          <nav aria-label="Einstellungsbereiche" className="flex flex-col gap-3">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p className="mb-1 px-3 text-eyebrow uppercase text-muted">{group.label}</p>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;
                    return (
                      <Button
                        key={item.id}
                        variant={isActive ? 'secondary' : 'ghost'}
                        fullWidth
                        static
                        onClick={() => setActiveTab(item.id as SettingsTab)}
                        aria-current={isActive ? 'page' : undefined}
                        title={item.desc}
                        className={`justify-start ${isActive ? 'bg-surface-sunken' : 'text-foreground-secondary'}`}
                      >
                        <Icon size={16} aria-hidden="true" className="shrink-0" />
                        {item.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <p className="mt-3 flex items-start gap-2 border-t border-border px-3 pt-3 text-caption text-muted">
            <AlertCircle size={14} className="mt-px shrink-0" aria-hidden="true" />
            Alle Änderungen wirken sich sofort auf neue Dokumente aus.
          </p>
        </div>

        {/* A grid of section cards; it scrolls on its own so the section list stays in view. */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-3.5">
            {renderActiveTab()}
          </div>
        </div>

        <DunningResultModal
          isOpen={showDunningResult}
          onClose={() => setShowDunningResult(false)}
          result={dunningResult}
        />

        {previewLevelIndex !== null && (
          <DunningLevelPreviewModal
            isOpen={previewModalOpen}
            onClose={() => setPreviewModalOpen(false)}
            subject={settings.dunning.levels[previewLevelIndex]?.subject ?? ''}
            text={settings.dunning.levels[previewLevelIndex]?.text ?? ''}
            levelNumber={previewLevelIndex + 1}
          />
        )}

        <ConfirmDialog
          open={pendingProfitDetermination !== null}
          title="Gewinnermittlung ändern"
          description="Bereits erfasste Buchungen und Auswertungen werden nicht umgerechnet. Sprich die Umstellung mit deiner Steuerberatung ab."
          confirmLabel="Umstellen"
          details={pendingProfitDetermination !== null && (
            <Select
              label="Gewinnermittlung"
              aria-label="Gewinnermittlung"
              fullWidth
              value={pendingProfitDetermination}
              onChange={(event) => setPendingProfitDetermination(event.target.value as BusinessReportingProfile['profitDetermination'])}
              hint={
                <>
                  {PROFIT_DETERMINATION_COPY[pendingProfitDetermination].hint}
                  {reportingProfile.legalForm === 'gmbh' && <span className="mt-1 block">Eine GmbH muss mit doppelter Buchführung geführt werden.</span>}
                </>
              }
            >
              <option value="eur" disabled={reportingProfile.legalForm === 'gmbh'}>EÜR</option>
              <option value="double_entry">Doppelte Buchführung</option>
            </Select>
          )}
          onConfirm={() => {
            if (pendingProfitDetermination) updateReportingProfile('profitDetermination', pendingProfitDetermination);
            setPendingProfitDetermination(null);
          }}
          onCancel={() => setPendingProfitDetermination(null)}
        />
      </div>
    </>
  );
};
