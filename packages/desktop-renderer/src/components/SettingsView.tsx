

import React, { useState } from 'react';
import {
  Building2, Landmark, FileDigit, Scale,
  Save, CheckCircle, HelpCircle, AlertCircle, Megaphone, Globe, Tags, Plus, Trash2, AlertTriangle, Mail, Repeat
} from 'lucide-react';
import { Button, ErrorState, useActionFeedback } from '@billme/ui';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import type { AppSettings, BusinessReportingProfile, DunningLevel } from '@billme/desktop-core/types';
import { ipc } from '../runtime-api';
import { useSetSettingsMutation, useSettingsQuery } from '../hooks/useSettings';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { DunningResultModal } from '@billme/desktop-ui/components/DunningResultModal';
import { DunningLevelPreviewModal } from '@billme/desktop-ui/components/DunningLevelPreviewModal';

type SettingsTab = 'company' | 'catalog' | 'finance' | 'numbers' | 'dunning' | 'legal' | 'portal' | 'system' | 'email';

const normalizeCategoryName = (value: string): string => value.trim();
const formatCount = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`;

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
      <div className="flex min-h-full items-center justify-center bg-background p-8">
        <ErrorState
          title="Einstellungen konnten nicht geladen werden"
          description="Ohne die gespeicherten Stammdaten würde das Formular leer starten und leere Daten speichern."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-background text-muted">
      <Spinner size="md" />
      <p role="status" className="text-sm font-medium">Einstellungen werden geladen …</p>
    </div>
  );
};

const SettingsForm: React.FC<{ initialSettings: AppSettings }> = ({ initialSettings }) => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>('company');
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
  const { notify } = useActionFeedback('settings');

  React.useEffect(() => {
    if (loadedSettings) {
      setSettings(loadedSettings);
      setReportingProfile(inferBusinessReportingProfile(loadedSettings));
    }
  }, [loadedSettings]);

  React.useEffect(() => {
    let cancelled = false;
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
      if (portalApiKeyTouched) {
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
      // ignore secret save errors (OS keychain issues should not block settings save)
    }

    // Save email credentials to keychain
    try {
      if (smtpPasswordTouched) {
        if (smtpPassword.trim()) {
          await ipc.secrets.set({ key: 'smtp.password', value: smtpPassword.trim() });
          setSmtpPasswordConfigured(true);
        } else {
          await ipc.secrets.delete({ key: 'smtp.password' });
          setSmtpPasswordConfigured(false);
        }
        setSmtpPasswordTouched(false);
      }

      if (resendApiKeyTouched) {
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
      // ignore secret save errors (OS keychain issues should not block settings save)
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
      notify('error', 'Fehler beim Mahnlauf: ' + String(error));
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
        message: String(error),
      });
    } finally {
      setEmailTesting(false);
    }
  };

  // Load email credentials from keychain on mount
  React.useEffect(() => {
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
        { id: 'system', label: 'System', icon: AlertCircle, desc: 'Backup & Audit' },
      ],
    },
  ];
  const navItems = navGroups.flatMap((g) => g.items);

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'company':
        return (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">Unternehmensdaten</h3>
              <p className="text-muted text-sm">Diese Informationen erscheinen im Kopf- und Fußbereich der Rechnung.</p>
            </div>

            <div className="grid grid-cols-1 gap-6">
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-firmenname">Firmenname</label>
                <input
                  id="settings-firmenname"
                  type="text"
                  value={settings.company.name}
                  onChange={(e) => updateNested('company', 'name', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-inhaber-geschaftsfuhrer">Inhaber / Geschäftsführer</label>
                <input
                  id="settings-inhaber-geschaftsfuhrer"
                  type="text"
                  value={settings.company.owner}
                  onChange={(e) => updateNested('company', 'owner', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-strae-hausnr">Straße & Hausnr.</label>
                  <input
                    id="settings-strae-hausnr"
                    type="text"
                    value={settings.company.street}
                    onChange={(e) => updateNested('company', 'street', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-plz">PLZ</label>
                  <input
                    id="settings-plz"
                    type="text"
                    value={settings.company.zip}
                    onChange={(e) => updateNested('company', 'zip', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-stadt">Stadt</label>
                <input
                  id="settings-stadt"
                  type="text"
                  value={settings.company.city}
                  onChange={(e) => updateNested('company', 'city', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
              <div className="border-t border-border-subtle my-4"></div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-e-mail-adresse">E-Mail Adresse</label>
                  <input
                    id="settings-e-mail-adresse"
                    type="email"
                    value={settings.company.email}
                    onChange={(e) => updateNested('company', 'email', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-telefon">Telefon</label>
                  <input
                    id="settings-telefon"
                    type="text"
                    value={settings.company.phone}
                    onChange={(e) => updateNested('company', 'phone', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-webseite">Webseite</label>
                <input
                  id="settings-webseite"
                  type="text"
                  value={settings.company.website}
                  onChange={(e) => updateNested('company', 'website', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
            </div>
          </div>
        );
      case 'catalog':
        return (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">Kategorien</h3>
              <p className="text-muted text-sm">
                Kategorien für „Produkte & Leistungen“. Änderungen können beim Speichern automatisch in Artikeln
                übernommen werden.
              </p>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-sm uppercase flex items-center gap-2">
                  <Tags size={16} /> Kategorien
                </h4>
                <Button
                  variant="dark"
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
                  <Plus size={16} /> Kategorie
                </Button>
              </div>

              {(settings.catalog?.categories ?? []).length === 0 ? (
                <div className="p-4 bg-surface rounded-xl border border-border-subtle text-sm text-muted">
                  Noch keine Kategorien. Lege Kategorien an, damit du sie bei Artikeln auswählen kannst.
                </div>
              ) : (
                <div className="space-y-3">
                  {(settings.catalog?.categories ?? []).map((cat, idx) => (
                    <div key={cat.id} className="flex items-center gap-3 bg-surface rounded-xl p-3 border border-border-subtle">
                      <div className="w-10 h-10 rounded-xl bg-surface-muted border border-border-subtle flex items-center justify-center text-xs font-semibold text-muted">
                        {String(idx + 1).padStart(2, '0')}
                      </div>
                      <div className="flex-1">
                        <label className="block mb-1 text-label text-foreground">
                          Name
                        </label>
                        <input
                          value={cat.name}
                          onChange={(e) => {
                            const name = e.target.value;
                            setSettings((prev) => {
                              const list = [...(prev.catalog?.categories ?? [])];
                              list[idx] = { ...list[idx]!, name };
                              return { ...prev, catalog: { categories: list } };
                            });
                          }}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        />
                      </div>
                      <button type="button"
                        onClick={() => {
                          setSettings((prev) => {
                            const list = (prev.catalog?.categories ?? []).filter((c) => c.id !== cat.id);
                            return { ...prev, catalog: { categories: list } };
                          });
                        }}
                        aria-label={`Kategorie ${cat.name} entfernen`}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      case 'finance':
        return (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">Bankverbindung & Steuer</h3>
              <p className="text-muted text-sm">Wichtig für den Zahlungsverkehr und die Pflichtangaben auf der Rechnung.</p>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle">
              <h4 className="font-semibold mb-4 flex items-center gap-2 text-sm uppercase">
                <Landmark size={16} /> Bankkonto
              </h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-bankname">Bankname</label>
                  <input id="settingsview-bankname"
                    type="text"
                    value={settings.finance.bankName}
                    onChange={(e) => updateNested('finance', 'bankName', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-iban">IBAN</label>
                    <input id="settingsview-iban"
                      type="text"
                      value={settings.finance.iban}
                      onChange={(e) => updateNested('finance', 'iban', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-bic">BIC</label>
                    <input id="settingsview-bic"
                      type="text"
                      value={settings.finance.bic}
                      onChange={(e) => updateNested('finance', 'bic', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-steuernummer">Steuernummer</label>
                <input
                  id="settings-steuernummer"
                  type="text"
                  value={settings.finance.taxId}
                  onChange={(e) => updateNested('finance', 'taxId', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-ust-idnr">USt-IdNr.</label>
                <input
                  id="settings-ust-idnr"
                  type="text"
                  value={settings.finance.vatId}
                  onChange={(e) => updateNested('finance', 'vatId', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-registergericht-hrb">Registergericht / HRB</label>
              <input
                id="settings-registergericht-hrb"
                type="text"
                value={settings.finance.registerCourt}
                onChange={(e) => updateNested('finance', 'registerCourt', e.target.value)}
                placeholder="z.B. Amtsgericht Berlin HRB 12345"
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
              />
            </div>
          </div>
        );
      case 'numbers':
        return (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">Nummernkreise</h3>
              <p className="text-muted text-sm">Definieren Sie das Format für Ihre Rechnungs-, Angebots- und Kundennummern.</p>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border">
              <div className="flex justify-between items-start mb-6">
                <h4 className="font-semibold flex items-center gap-2">
                  <FileDigit size={16} /> Rechnungen
                </h4>
                <div className="bg-surface px-3 py-1 rounded-lg shadow-sm">
                  <span className="text-xs font-semibold text-muted uppercase mr-2">Vorschau:</span>
                  <span className="font-mono font-semibold">{nextInvoicePreview}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-label text-foreground">Präfix Format</label>
                    <div className="group relative">
                      <HelpCircle size={12} className="text-muted cursor-help" />
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-dark-base text-background text-xs p-2 rounded-sm pointer-events-none opacity-0 group-hover:opacity-100 motion-safe:transition-opacity motion-reduce:transition-none z-[var(--z-dropdown)]">
                        %Y = Aktuelles Jahr (z.B. 2023)
                      </div>
                    </div>
                  </div>
                  <input
                    type="text"
                    value={settings.numbers.invoicePrefix}
                    onChange={(e) => updateNested('numbers', 'invoicePrefix', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-nachste-nummer">Nächste Nummer</label>
                  <input
                    id="settings-nachste-nummer"
                    type="number"
                    value={settings.numbers.nextInvoiceNumber}
                    min={1}
                    onChange={(e) => updateNested(
                      'numbers',
                      'nextInvoiceNumber',
                      parsePositiveInteger(e.target.value, settings.numbers.nextInvoiceNumber),
                    )}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors tabular-nums"
                  />
                </div>
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-mindestlange-padding">Mindestlänge (Padding)</label>
                <input
                  id="settings-mindestlange-padding"
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
                  className="w-full accent-dark-base h-2 bg-border rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-xs font-semibold text-muted mt-1">
                  <span>1</span>
                  <span className="tabular-nums">{settings.numbers.numberLength} Stellen (z.B. 001)</span>
                  <span>6</span>
                </div>
              </div>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle">
              <div className="flex justify-between items-start mb-6">
                <h4 className="font-semibold flex items-center gap-2">
                  <FileDigit size={16} /> Angebote
                </h4>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-prafix-format">Präfix Format</label>
                  <input
                    id="settings-prafix-format"
                    type="text"
                    value={settings.numbers.offerPrefix}
                    onChange={(e) => updateNested('numbers', 'offerPrefix', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-nachste-nummer-2">Nächste Nummer</label>
                  <input
                    id="settings-nachste-nummer-2"
                    type="number"
                    value={settings.numbers.nextOfferNumber}
                    min={1}
                    onChange={(e) => updateNested(
                      'numbers',
                      'nextOfferNumber',
                      parsePositiveInteger(e.target.value, settings.numbers.nextOfferNumber),
                    )}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors tabular-nums"
                  />
                </div>
              </div>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle">
              <div className="flex justify-between items-start mb-6">
                <h4 className="font-semibold flex items-center gap-2">
                  <FileDigit size={16} /> Kunden
                </h4>
                <div className="bg-surface px-3 py-1 rounded-lg shadow-sm">
                  <span className="text-xs font-semibold text-muted uppercase mr-2">Vorschau:</span>
                  <span className="font-mono font-semibold">{nextCustomerPreview}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-prafix-format-2">Präfix Format</label>
                  <input
                    id="settings-prafix-format-2"
                    type="text"
                    value={settings.numbers.customerPrefix}
                    onChange={(e) => updateNested('numbers', 'customerPrefix', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-nachste-nummer-3">Nächste Nummer</label>
                  <input
                    id="settings-nachste-nummer-3"
                    type="number"
                    value={settings.numbers.nextCustomerNumber}
                    min={1}
                    onChange={(e) => updateNested(
                      'numbers',
                      'nextCustomerNumber',
                      parsePositiveInteger(e.target.value, settings.numbers.nextCustomerNumber),
                    )}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors tabular-nums"
                  />
                </div>
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-mindestlange-padding-2">Mindestlänge (Padding)</label>
                <input
                  id="settings-mindestlange-padding-2"
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
                  className="w-full accent-dark-base h-2 bg-border rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-xs font-semibold text-muted mt-1">
                  <span>1</span>
                  <span className="tabular-nums">{settings.numbers.customerNumberLength} Stellen (z.B. 0001)</span>
                  <span>8</span>
                </div>
              </div>
            </div>
          </div>
        );
      case 'email':
        return (
          <div className="max-w-3xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">E-Mail Konfiguration</h3>
              <p className="text-muted text-sm">Konfigurieren Sie SMTP oder Resend für den E-Mail-Versand.</p>
            </div>

            {/* Provider Selection */}
            <div className="bg-surface border border-border rounded-xl p-6">
              <h4 className="font-semibold mb-4">E-Mail-Anbieter</h4>
              <div className="flex gap-3">
                <button type="button"
                  aria-pressed={settings.email.provider === 'none'}
                  onClick={() => updateNested('email', 'provider', 'none')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                    settings.email.provider === 'none'
                      ? 'border-foreground bg-surface-muted'
                      : 'border border-control-border hover:border-control-border'
                  }`}
                >
                  <div className="font-semibold">Kein Versand</div>
                  <div className="text-xs text-muted mt-1">E-Mails deaktiviert</div>
                </button>
                <button type="button"
                  aria-pressed={settings.email.provider === 'smtp'}
                  onClick={() => updateNested('email', 'provider', 'smtp')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                    settings.email.provider === 'smtp'
                      ? 'border-foreground bg-surface-muted'
                      : 'border border-control-border hover:border-control-border'
                  }`}
                >
                  <div className="font-semibold">SMTP</div>
                  <div className="text-xs text-muted mt-1">Eigener Mail-Server</div>
                </button>
                <button type="button"
                  aria-pressed={settings.email.provider === 'resend'}
                  onClick={() => updateNested('email', 'provider', 'resend')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                    settings.email.provider === 'resend'
                      ? 'border-foreground bg-surface-muted'
                      : 'border border-control-border hover:border-control-border'
                  }`}
                >
                  <div className="font-semibold">Resend</div>
                  <div className="text-xs text-muted mt-1">Transactional API</div>
                </button>
              </div>
            </div>

            {/* SMTP Configuration */}
            {settings.email.provider === 'smtp' && (
              <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
                <h4 className="font-semibold">SMTP-Konfiguration</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-server-host">Server (Host)</label>
                    <input id="settingsview-server-host"
                      type="text"
                      value={settings.email.smtpHost}
                      onChange={(e) => updateNested('email', 'smtpHost', e.target.value)}
                      placeholder="smtp.example.com"
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-port">Port</label>
                    <input id="settingsview-port"
                      type="number"
                      value={settings.email.smtpPort}
                      onChange={(e) => updateNested('email', 'smtpPort', Number(e.target.value))}
                      placeholder="587"
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                    />
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.email.smtpSecure}
                      onChange={(e) => updateNested('email', 'smtpSecure', e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span className="text-sm font-medium">SSL/TLS verwenden (empfohlen für Port 465)</span>
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-benutzername">Benutzername</label>
                  <input id="settingsview-benutzername"
                    type="text"
                    value={settings.email.smtpUser}
                    onChange={(e) => updateNested('email', 'smtpUser', e.target.value)}
                    placeholder="user@example.com"
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-passwort">Passwort</label>
                <input id="settingsview-passwort"
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => {
                    setSmtpPassword(e.target.value);
                    setSmtpPasswordTouched(true);
                  }}
                  placeholder={smtpPasswordConfigured ? '•••••••• (gespeichert)' : '••••••••'}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                  <p className="text-xs text-muted mt-1">Wird sicher im Schlüsselbund des Systems gespeichert.</p>
                </div>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
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
                  {emailTestStatus && (
                    <div className={`mt-3 p-3 rounded-lg ${emailTestStatus.success ? 'bg-success-bg text-success-text' : 'bg-error-bg text-error-text'}`}>
                      <p className="text-sm font-medium">{emailTestStatus.message}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Resend Configuration */}
            {settings.email.provider === 'resend' && (
              <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
                <h4 className="font-semibold">Resend API-Konfiguration</h4>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-api-key">API-Key</label>
                  <input id="settingsview-api-key"
                    type="password"
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
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                  <p className="text-xs text-muted mt-1">Wird sicher im Schlüsselbund des Systems gespeichert.</p>
                </div>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleEmailTest}
                    loading={emailTesting}
                    disabled={!resendApiKey && !resendApiKeyConfigured}
                  >
                    API-Schlüssel testen
                  </Button>
                  {emailTestStatus && (
                    <div className={`mt-3 p-3 rounded-lg ${emailTestStatus.success ? 'bg-success-bg text-success-text' : 'bg-error-bg text-error-text'}`}>
                      <p className="text-sm font-medium">{emailTestStatus.message}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sender Information */}
            {settings.email.provider !== 'none' && (
              <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
                <h4 className="font-semibold">Absender-Informationen</h4>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-absender-name">Absender-Name</label>
                  <input id="settingsview-absender-name"
                    type="text"
                    value={settings.email.fromName}
                    onChange={(e) => updateNested('email', 'fromName', e.target.value)}
                    placeholder={settings.company.name || 'Meine Firma'}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-2" htmlFor="settingsview-absender-e-mail">Absender-E-Mail</label>
                  <input id="settingsview-absender-e-mail"
                    type="email"
                    value={settings.email.fromEmail}
                    onChange={(e) => updateNested('email', 'fromEmail', e.target.value)}
                    placeholder={settings.company.email || 'info@example.com'}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  />
                </div>
              </div>
            )}
          </div>
        );
      case 'dunning': {
        const dunningEnabled = settings.automation?.dunningEnabled ?? false;
        const activeLevelCount = settings.dunning.levels.filter(l => l.enabled).length;
        const totalLevels = settings.dunning.levels.length;

        return (
          <div className="max-w-4xl space-y-6">
            {/* Header */}
            <div className="flex items-end justify-between">
              <div>
                <h3 className="text-xl font-semibold mb-1">Mahnwesen</h3>
                <p className="text-muted text-sm">Automatische Zahlungserinnerungen und Mahnungen</p>
              </div>
            </div>

            {/* Master Enable/Disable Toggle */}
            <button type="button"
              role="switch"
              aria-checked={dunningEnabled}
              onClick={() => updateAutomation('dunningEnabled', !dunningEnabled)}
              className="w-full text-left bg-surface border-2 border-border-subtle rounded-xl p-6 transition-colors hover:border-control-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${dunningEnabled ? 'bg-dark-base border-dark-base' : 'border-control-border'}`}
                >
                  {dunningEnabled && <CheckCircle size={14} className="text-success-text" />}
                </span>
                <div>
                  <h4 className="font-semibold text-sm">Mahnwesen aktivieren</h4>
                  <p className="text-xs text-muted mt-1">Automatische Zahlungserinnerungen für überfällige Rechnungen</p>
                </div>
              </div>
            </button>

            {/* Email Provider Warning (if not configured) */}
            {dunningEnabled && settings.email.provider === 'none' && (
              <div className="bg-warning-bg border border-warning-border rounded-xl p-4 flex items-start gap-3">
                <AlertTriangle size={16} className="text-warning-text shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-warning-text">E-Mail-Provider erforderlich</p>
                  <p className="text-xs text-warning-text mt-1">
                    Konfigurieren Sie SMTP oder Resend im E-Mail-Tab, um Mahnungen versenden zu können.
                  </p>
                </div>
              </div>
            )}

            {/* Automation Settings Card (only when enabled) */}
            {dunningEnabled && (
              <div className="bg-surface-muted border border-border rounded-xl p-6 space-y-5">
                <h4 className="font-semibold flex items-center gap-2">
                  <Megaphone size={16} /> Automatisierung
                </h4>

                {/* Schedule Time */}
                <div>
                  <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-tagliche-ausfuhrung-um">Tägliche Ausführung um</label>
                  <input
                    id="settings-tagliche-ausfuhrung-um"
                    type="time"
                    value={settings.automation?.dunningRunTime ?? '09:00'}
                    onChange={(e) => updateAutomation('dunningRunTime', e.target.value)}
 className="px-2.5 h-8 hover:border-ink-500 w-48 bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  />
                </div>

                {/* Status Display */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-surface border border-border-subtle rounded-lg p-3">
                    <label className="block mb-1 text-label text-foreground">Letzter Lauf</label>
                    <p className="text-sm font-semibold text-foreground">
                      {settings.automation?.lastDunningRun
                        ? new Date(settings.automation.lastDunningRun).toLocaleDateString('de-DE', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : 'Noch nie'}
                    </p>
                  </div>
                  <div className="bg-surface border border-border-subtle rounded-lg p-3">
                    <label className="block mb-1 text-label text-foreground">Nächster Lauf</label>
                    <p className="text-sm font-semibold text-foreground">
                      {calculateNextRun(settings.automation?.dunningRunTime ?? '09:00')}
                    </p>
                  </div>
                </div>

                {/* Manual Trigger */}
                <Button
                  variant="dark"
                  fullWidth
                  onClick={handleManualDunningRun}
                  loading={dunningRunning}
                  disabled={settings.email.provider === 'none' || activeLevelCount === 0}
                >
                  <Megaphone size={16} />
                  Jetzt manuell ausführen
                </Button>
              </div>
            )}

            {/* Dunning Levels Configuration (only when enabled) */}
            {dunningEnabled && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold">Mahnstufen</h4>
                  <p className="text-sm text-muted tabular-nums">
                    {activeLevelCount} von {totalLevels} aktiv
                  </p>
                </div>

                {settings.dunning.levels.map((level, index) => (
                  <div
                    key={level.id}
                    className={`bg-surface border rounded-xl overflow-hidden transition-colors ${
                      level.enabled ? 'border-border hover:border-control-border' : 'border-border-subtle'
                    }`}
                  >
                    {/* Header with inline toggle */}
                    <div className="bg-surface-muted px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* Individual Enable Toggle */}
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={level.enabled}
                            aria-label={`Mahnstufe ${level.id} aktivieren`}
                            onChange={(e) => updateDunningLevel(index, 'enabled', e.target.checked)}
                            className="sr-only peer"
                          />
 <div className="w-11 h-6 bg-control-border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus-ring rounded-full peer peer-checked:after:translate-x-full motion-safe:peer-checked:after:transition-transform motion-safe:peer-checked:after:duration-150 motion-reduce:transition-none after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface after:rounded-full after:h-5 after:w-5 peer-checked:bg-dark-base"></div>
                        </label>

                        <span className={`w-7 h-7 rounded-full flex items-center justify-center font-semibold text-xs ${
                          level.enabled ? 'bg-dark-base text-background' : 'bg-border-subtle text-muted'
                        }`}>
                          {level.id}
                        </span>
                        <h5 className="font-semibold text-sm">{level.name}</h5>
                      </div>

                      {/* Quick edit inline */}
                      <div className="flex items-center gap-4 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted font-medium">nach</span>
                          <input
                            type="number"
                            value={level.daysAfterDueDate}
                            onChange={(e) => updateDunningLevel(index, 'daysAfterDueDate', Number(e.target.value))}
                            disabled={!level.enabled}
 className="px-2.5 h-8 hover:border-ink-500 text-sm w-14 bg-surface border border-control-border rounded-sm text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-50"
                          />
                          <span className="text-muted font-medium">Tagen</span>
                        </div>
                        <div className="h-4 w-px bg-border-subtle"></div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted font-medium">Gebühr</span>
                          <input
                            type="number"
                            step="0.01"
                            value={level.fee}
                            onChange={(e) => updateDunningLevel(index, 'fee', Number(e.target.value))}
                            disabled={!level.enabled}
 className="px-2.5 h-8 hover:border-ink-500 text-sm w-16 bg-surface border border-control-border rounded-sm text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-50"
                          />
                          <span className="text-muted font-medium">€</span>
                        </div>
                      </div>
                    </div>

                    {/* Content (subject + text) */}
                    {level.enabled && (
                      <div className="p-4 space-y-3">
                        <div>
                          <label className="block mb-1.5 text-label text-foreground" htmlFor="settingsview-betreff">Betreff</label>
                          <input id="settingsview-betreff"
                            type="text"
                            value={level.subject}
                            onChange={(e) => updateDunningLevel(index, 'subject', e.target.value)}
 className="px-2.5 h-8 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                            placeholder="z.B. Zahlungserinnerung für Rechnung %N"
                          />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-label text-foreground">Einleitungstext</label>
                            <button type="button"
                              onClick={() => {
                                setPreviewLevelIndex(index);
                                setPreviewModalOpen(true);
                              }}
                              className="px-2.5 py-1 bg-surface-muted hover:bg-border text-foreground rounded-sm text-xs font-semibold transition-colors"
                            >
                              Vorschau
                            </button>
                          </div>
                          <textarea
                            rows={2}
                            value={level.text}
                            onChange={(e) => updateDunningLevel(index, 'text', e.target.value)}
 className="px-2.5 py-2 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
                            placeholder="z.B. leider haben wir noch keinen Zahlungseingang für die Rechnung %N vom %D über %A erhalten..."
                          />
                          <div className="mt-1.5 flex items-center justify-between">
                            <div className="flex flex-wrap gap-1">
                              {[
                                { code: '%N', label: 'Nr.', present: level.text.includes('%N') },
                                { code: '%D', label: 'Datum', present: level.text.includes('%D') },
                                { code: '%A', label: 'Betrag', present: level.text.includes('%A') },
                                { code: '%C', label: 'Kunde', present: level.text.includes('%C') },
                              ].map((ph) => (
                                <button type="button"
                                  key={ph.code}
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
                                  className={`px-1.5 py-1 rounded-sm text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                                    ph.present
                                      ? 'bg-success-bg text-success-text'
                                      : 'bg-surface-muted text-muted hover:bg-border'
                                  }`}
                                  aria-label={`${ph.label} einfügen`}
                                >
                                  {ph.code}
                                </button>
                              ))}
                            </div>
                            {(!level.text.includes('%N') || !level.text.includes('%A')) && (
                              <div className="flex items-center gap-1 text-warning-text">
                                <AlertTriangle size={12} />
                                <span className="text-xs font-medium">%N und %A empfohlen</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Disabled State Message */}
            {!dunningEnabled && (
              <div className="text-center py-12 text-muted">
                <Megaphone size={48} className="mx-auto mb-4 opacity-30" />
                <p>Aktivieren Sie das Mahnwesen, um Mahnstufen zu konfigurieren</p>
              </div>
            )}

            {/* Recurring Invoices Section */}
            <div className="border-t border-border pt-8 mt-8">
              <div className="mb-6">
                <h3 className="text-xl font-semibold mb-1 flex items-center gap-2">
                  <Repeat size={20} /> Automatische Abo-Rechnungen
                </h3>
                <p className="text-muted text-sm">Automatische Generierung wiederkehrender Rechnungen</p>
              </div>

              {/* Master Enable/Disable Toggle */}
              <button type="button"
                role="switch"
                aria-checked={settings.automation.recurringEnabled}
                onClick={() => updateAutomation('recurringEnabled', !settings.automation.recurringEnabled)}
                className="w-full text-left bg-surface border-2 border-border-subtle rounded-xl p-6 transition-colors hover:border-control-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.automation.recurringEnabled ? 'bg-dark-base border-dark-base' : 'border-control-border'}`}
                  >
                    {settings.automation.recurringEnabled && <CheckCircle size={14} className="text-success-text" />}
                  </span>
                  <div>
                    <h4 className="font-semibold text-sm">Automatische Generierung aktivieren</h4>
                    <p className="text-xs text-muted mt-1">Abo-Rechnungen werden automatisch zum festgelegten Zeitpunkt erstellt</p>
                  </div>
                </div>
              </button>

              {/* Automation Settings Card (only when enabled) */}
              {settings.automation.recurringEnabled && (
                <div className="bg-surface-muted border border-border rounded-xl p-6 space-y-5 mt-4">
                  <h4 className="font-semibold flex items-center gap-2">
                    <Repeat size={16} /> Automatisierung
                  </h4>

                  {/* Schedule Time */}
                  <div>
                    <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-tagliche-ausfuhrung-um-2">Tägliche Ausführung um</label>
                    <input
                      id="settings-tagliche-ausfuhrung-um-2"
                      type="time"
                      value={settings.automation?.recurringRunTime ?? '03:00'}
                      onChange={(e) => updateAutomation('recurringRunTime', e.target.value)}
 className="px-2.5 h-8 hover:border-ink-500 w-48 bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    />
                    <p className="text-xs text-muted mt-2">
                      Empfohlen: 03:00 Uhr (nachts, um Konflikte mit Mahnlauf zu vermeiden)
                    </p>
                  </div>

                  {/* Status Display */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-surface border border-border-subtle rounded-lg p-3">
                      <label className="block mb-1 text-label text-foreground">Letzter Lauf</label>
                      <p className="text-sm font-semibold text-foreground">
                        {settings.automation?.lastRecurringRun
                          ? new Date(settings.automation.lastRecurringRun).toLocaleDateString('de-DE', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit'
                            })
                          : 'Noch nie'}
                      </p>
                    </div>
                    <div className="bg-surface border border-border-subtle rounded-lg p-3">
                      <label className="block mb-1 text-label text-foreground">Nächster Lauf</label>
                      <p className="text-sm font-semibold text-foreground">
                        {calculateNextRun(settings.automation?.recurringRunTime ?? '03:00')}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      }
      case 'legal':
        return (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">Rechtliches & Texte</h3>
              <p className="text-muted text-sm">Steuerliche Einstellungen und Standardtexte.</p>
            </div>

            <button type="button"
              role="switch"
              aria-checked={settings.legal.smallBusinessRule}
              onClick={() => updateNested('legal', 'smallBusinessRule', !settings.legal.smallBusinessRule)}
              className="w-full text-left bg-surface border-2 border-border-subtle rounded-xl p-6 transition-colors hover:border-control-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.legal.smallBusinessRule ? 'bg-dark-base border-dark-base' : 'border-control-border'}`}
                  >
                    {settings.legal.smallBusinessRule && <CheckCircle size={14} className="text-success-text" />}
                  </span>
                  <div>
                    <h4 className="font-semibold text-sm">Kleinunternehmerregelung anwenden</h4>
                    <p className="text-xs text-muted mt-1">Keine Umsatzsteuerberechnung gem. § 19 UStG.</p>
                  </div>
                </div>
              </div>
            </button>

            <div className="bg-surface border-2 border-border-subtle rounded-xl p-6 space-y-5">
              <div>
                <h4 className="font-semibold text-sm">Berichtsprofil</h4>
                <p className="text-xs text-muted mt-1">Der aktuelle Berichts- und Steuerumfang unterstützt Deutschland. AT/CH-Berichte sind noch nicht verfügbar.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <label className="block text-label text-foreground">
                  Rechtsraum
                  <select aria-label="Rechtsraum" value={reportingProfile.jurisdiction} onChange={(event) => updateReportingProfile('jurisdiction', event.target.value as 'DE')} className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground">
                    <option value="DE">Deutschland</option>
                  </select>
                </label>
                <label className="block text-label text-foreground">
                  Rechtsform
                  <select aria-label="Rechtsform" value={reportingProfile.legalForm} onChange={(event) => updateReportingProfile('legalForm', event.target.value as BusinessReportingProfile['legalForm'])} className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground">
                    <option value="sole_proprietor">Einzelunternehmen</option>
                    <option value="gmbh">GmbH</option>
                  </select>
                </label>
                <label className="block text-label text-foreground">
                  Gewinnermittlung
                  <select aria-label="Gewinnermittlung" value={reportingProfile.profitDetermination} onChange={(event) => updateReportingProfile('profitDetermination', event.target.value as BusinessReportingProfile['profitDetermination'])} className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground">
                    <option value="eur" disabled={reportingProfile.legalForm === 'gmbh'}>EÜR</option>
                    <option value="double_entry">Doppelte Buchführung</option>
                  </select>
                </label>
                {reportingProfile.legalForm === 'gmbh' && (
                  <label className="block text-label text-foreground">
                    GmbH-Größe
                    <select aria-label="GmbH-Größe" value={reportingProfile.hgbSizeClass ?? ''} onChange={(event) => updateReportingProfile('hgbSizeClass', event.target.value as 'micro' | 'small')} className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground">
                      <option value="micro">Micro</option>
                      <option value="small">Small</option>
                    </select>
                  </label>
                )}
                {reportingProfile.profitDetermination === 'double_entry' && (
                  <label className="block text-label text-foreground">
                    Kontenrahmen
                    <select aria-label="Kontenrahmen" value={reportingProfile.chart ?? ''} onChange={(event) => updateReportingProfile('chart', event.target.value as 'SKR03' | 'SKR04')} className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground">
                      <option value="SKR03">SKR03</option>
                      <option value="SKR04">SKR04</option>
                    </select>
                  </label>
                )}
                <label className="block text-label text-foreground">
                  Wirtschaftsjahresbeginn (MM-TT)
                  <input aria-label="Wirtschaftsjahresbeginn" value={reportingProfile.fiscalYearStart} onChange={(event) => updateReportingProfile('fiscalYearStart', event.target.value)} placeholder="01-01" className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground" />
                </label>
                <label className="block text-label text-foreground">
                  Umsatzsteuer-Methode
                  <select aria-label="Umsatzsteuer-Methode" value={reportingProfile.vatMethod} onChange={(event) => updateReportingProfile('vatMethod', event.target.value as BusinessReportingProfile['vatMethod'])} className="px-3 h-10 hover:border-ink-500 text-sm mt-2 w-full bg-surface border border-control-border rounded-control text-foreground">
                    <option value="soll">Soll-Versteuerung</option>
                    <option value="ist">Ist-Versteuerung</option>
                  </select>
                </label>
              </div>
              {reportingProfile.legalForm === 'gmbh' && reportingProfile.profitDetermination !== 'double_entry' && <p className="text-xs text-error-text">Eine GmbH muss mit doppelter Buchführung geführt werden.</p>}
            </div>

            <button type="button"
              role="switch"
              aria-checked={settings.eInvoice.enabled}
              onClick={() => updateNested('eInvoice', 'enabled', !settings.eInvoice.enabled)}
              className="w-full text-left bg-surface border-2 border-border-subtle rounded-xl p-6 transition-colors hover:border-control-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.eInvoice.enabled ? 'bg-dark-base border-dark-base' : 'border-control-border'}`}
                  >
                    {settings.eInvoice.enabled && <CheckCircle size={14} className="text-success-text" />}
                  </span>
                  <div>
                    <h4 className="font-semibold text-sm">ZUGFeRD Export für Rechnungen aktivieren</h4>
                    <p className="text-xs text-muted mt-1">
                      Exportiert Rechnungen als ZUGFeRD EN16931 (Profil {settings.eInvoice.profile}, Version {settings.eInvoice.version}).
                    </p>
                  </div>
                </div>
              </div>
            </button>

            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-sitzland-des-verkaufers">Sitzland des Verkäufers</label>
                <select
                  id="settings-sitzland-des-verkaufers"
                  value={settings.legal.countryCode ?? 'DE'}
                  onChange={(e) => updateNested('legal', 'countryCode', e.target.value)}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                >
                  <option value="DE">Deutschland</option>
                  <option value="AT">Österreich</option>
                  <option value="CH">Schweiz</option>
                </select>
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-standard-umsatzsteuer">Standard Umsatzsteuer (%)</label>
                <input
                  id="settings-standard-umsatzsteuer"
                  type="number"
                  value={settings.legal.defaultVatRate}
                  disabled={settings.legal.smallBusinessRule}
                  onChange={(e) => updateNested('legal', 'defaultVatRate', parseFloat(e.target.value))}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-zahlungsziel-tage">Zahlungsziel (Tage)</label>
                <input
                  id="settings-zahlungsziel-tage"
                  type="number"
                  value={settings.legal.paymentTermsDays}
                  onChange={(e) => updateNested('legal', 'paymentTermsDays', parseInt(e.target.value))}
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>
            </div>

            <div className="bg-surface border border-border-subtle rounded-xl p-6">
              <h4 className="font-semibold text-sm mb-2">Umsatzsteuer-Basis (Übersicht)</h4>
              <p className="text-xs text-muted mb-4">
                Soll: basiert auf gestellten Rechnungen (Status ≠ Entwurf) nach Rechnungsdatum. Ist: basiert auf erfassten Zahlungen nach Zahlungsdatum.
              </p>
              <div className="flex items-center gap-2 bg-surface-muted/80 p-1.5 rounded-full border border-border w-fit">
                {(['soll', 'ist'] as const).map((m) => (
                  <button type="button"
                    key={m}
                    onClick={() => updateNested('legal', 'taxAccountingMethod', m)}
                    className={`px-5 py-2 rounded-control text-xs font-semibold transition-colors ${
                      (settings.legal.taxAccountingMethod ?? 'soll') === m
                        ? 'bg-dark-base text-background shadow-md'
                        : 'text-muted hover:bg-surface hover:text-foreground hover:shadow-sm'
                    }`}
                  >
                    {m === 'soll' ? 'Soll' : 'Ist'}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-border-subtle pt-6">
              <h4 className="font-semibold text-sm mb-4">Standardtexte</h4>

              <div className="mb-6">
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-einleitungstext-standard">Einleitungstext (Standard)</label>
                <textarea
                  id="settings-einleitungstext-standard"
                  value={settings.legal.defaultIntroText}
                  onChange={(e) => updateNested('legal', 'defaultIntroText', e.target.value)}
                  rows={3}
 className="px-3 py-2.5 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none transition-colors"
                />
              </div>
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-fuzeilentext-zusatz">Fußzeilentext (Zusatz)</label>
                <textarea
                  id="settings-fuzeilentext-zusatz"
                  value={settings.legal.defaultFooterText}
                  onChange={(e) => updateNested('legal', 'defaultFooterText', e.target.value)}
                  rows={2}
 className="px-3 py-2.5 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none transition-colors"
                />
              </div>
            </div>
          </div>
        );
      case 'portal':
        return (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-1">Angebotsportal</h3>
              <p className="text-muted text-sm">Angebotslinks veröffentlichen und Status synchronisieren.</p>
            </div>

            <div className="bg-surface border-2 border-border-subtle rounded-xl p-6 space-y-6">
              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-portal-basis-url">Portal-Basis-URL</label>
                <input
                  id="settings-portal-basis-url"
                  type="text"
                  value={settings.portal.baseUrl}
                  onChange={(e) => updateNested('portal', 'baseUrl', e.target.value)}
                  placeholder="https://offers.example.com"
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
                <p className="text-xs text-muted mt-2">Tipp: Einrichtungsseite im Portal: <span className="font-mono">/admin/setup</span></p>
              </div>

              <div>
                <label className="block mb-1.5 text-label text-foreground" htmlFor="settings-publish-api-schlussel-optional">Publish-API-Schlüssel (optional)</label>
                <input
                  id="settings-publish-api-schlussel-optional"
                  type="password"
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
 className="px-3 h-10 hover:border-ink-500 text-sm w-full bg-surface border border-control-border rounded-control text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3 items-center">
                <button type="button"
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
                  className="px-5 py-3 rounded-xl font-semibold bg-surface border border-border hover:bg-surface-muted transition-colors w-full sm:w-auto"
                >
                  Verbindung testen
                </button>
                <div className="flex-1 text-sm font-medium text-muted w-full">
                  {portalTestStatus}
                </div>
              </div>
            </div>
          </div>
        );
      case 'system':
        return (
          <div className="max-w-2xl space-y-10">
            <div>
              <h3 className="text-xl font-semibold mb-1">System</h3>
              <p className="text-muted text-sm">Audit-Log, Backup und Wiederherstellung.</p>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h4 className="text-lg font-semibold text-foreground">Audit</h4>
                  <p className="text-sm text-muted">Audit-Log prüfen und als CSV exportieren.</p>
                </div>
                <div className="flex gap-3">
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
                    variant="dark"
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
              </div>
              <div className="text-sm font-medium text-muted w-full">
                {auditStatus}
              </div>
            </div>

            <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle space-y-4">
              <div>
                <h4 className="text-lg font-semibold text-foreground">Backup</h4>
                <p className="text-sm text-muted">
                  Datenbank sichern oder aus einer Sicherung wiederherstellen.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
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

                <div className="flex-1 flex gap-2">
                  <input
                    value={backupPath}
                    onChange={(e) => setBackupPath(e.target.value)}
                    placeholder="Pfad zur .pglite.tar-Sicherung..."
 className="px-3 h-10 hover:border-ink-500 flex-1 bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  />
                  <Button
                    variant="dark"
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
              </div>
              <div className="text-sm font-medium text-muted w-full">
                {backupStatus}
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-surface rounded-panel shadow-xs h-full flex overflow-hidden relative">

      {/* Sidebar Navigation. The card is capped at the page height, so the
          nine tabs can outgrow it; the sidebar owns that overflow instead of
          pushing the save footer below the fold. */}
      <div className="w-64 bg-surface-muted border-r border-border-subtle px-4 py-6 flex flex-col overflow-y-auto">
        <h1 className="text-title px-2 mb-6">Einstellungen</h1>
        <nav aria-label="Einstellungsbereiche" className="space-y-5">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="text-caption text-muted mb-1 px-2">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button type="button"
                      key={item.id}
                      onClick={() => setActiveTab(item.id as SettingsTab)}
                      aria-current={isActive ? 'page' : undefined}
                      title={item.desc}
                      className={`w-full h-9 text-left px-2 rounded-control flex items-center gap-2.5 text-label transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                        isActive
                          ? 'bg-surface text-foreground shadow-sm'
                          : 'text-muted hover:bg-ink-100 hover:text-foreground'
                      }`}
                    >
                      <Icon size={16} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto">
             <p className="flex items-start gap-2 px-2 pt-6 text-caption text-muted">
                 <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" />
                 Alle Änderungen wirken sich sofort auf neue Dokumente aus.
             </p>
        </div>
      </div>

      {/* Main Content Form. The column stretches to the card height, so the save
          footer sits at the card end and the tab body scrolls above it. */}
      <div className="flex-1 flex flex-col">
         <div className="flex-1 overflow-y-auto px-8 py-8 lg:px-12">

            {renderActiveTab()}

         </div>

         {/* Footer Actions */}
         <div className="px-8 py-4 border-t border-border-subtle flex justify-end bg-surface">
             <Button
                onClick={handleSave}
                loading={setSettingsMutation.isPending}
             >
                 <Save size={16} aria-hidden="true" />
                 Einstellungen speichern
             </Button>
         </div>
      </div>

      {/* Dunning Result Modal */}
      <DunningResultModal
        isOpen={showDunningResult}
        onClose={() => setShowDunningResult(false)}
        result={dunningResult}
      />

      {/* Dunning Level Preview Modal */}
      {previewLevelIndex !== null && (
        <DunningLevelPreviewModal
          isOpen={previewModalOpen}
          onClose={() => setPreviewModalOpen(false)}
          subject={settings.dunning.levels[previewLevelIndex]?.subject ?? ''}
          text={settings.dunning.levels[previewLevelIndex]?.text ?? ''}
          levelNumber={previewLevelIndex + 1}
        />
      )}
    </div>
  );
};
