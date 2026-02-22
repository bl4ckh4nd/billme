

import React, { useState } from 'react';
import {
  Building2, Landmark, FileDigit, Scale,
  Save, CheckCircle, HelpCircle, AlertCircle, Megaphone, Globe, Tags, Plus, Trash2, AlertTriangle, Mail, Repeat
} from 'lucide-react';
import { Button } from '@billme/ui';
import { AppSettings, DunningLevel } from '../types';
import { MOCK_SETTINGS } from '../data/mockData';
import { ipc } from '../ipc/client';
import { useSetSettingsMutation, useSettingsQuery } from '../hooks/useSettings';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { DunningResultModal } from './DunningResultModal';
import { DunningLevelPreviewModal } from './DunningLevelPreviewModal';

const normalizeCategoryName = (value: string): string => value.trim();

export const SettingsView: React.FC = () => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<
    'company' | 'catalog' | 'finance' | 'numbers' | 'dunning' | 'legal' | 'portal' | 'system' | 'email'
  >('company');
  const { data: loadedSettings } = useSettingsQuery();
  const setSettingsMutation = useSetSettingsMutation();
  const [settings, setSettings] = useState<AppSettings>(loadedSettings ?? MOCK_SETTINGS);
  const [showSaveToast, setShowSaveToast] = useState(false);
  const [backupPath, setBackupPath] = useState('');
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

  React.useEffect(() => {
    if (loadedSettings) setSettings(loadedSettings);
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

    setShowSaveToast(true);
    setTimeout(() => setShowSaveToast(false), 3000);
  };

  const updateNested = (section: keyof AppSettings, field: string, value: any) => {
    setSettings(prev => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value
      }
    }));
  };
  
  const updateDunningLevel = (index: number, field: keyof DunningLevel, value: any) => {
      const newLevels = [...settings.dunning.levels];
      newLevels[index] = { ...newLevels[index], [field]: value };
      setSettings(prev => ({
          ...prev,
          dunning: { ...prev.dunning, levels: newLevels }
      }));
  };

  const updateAutomation = (field: string, value: any) => {
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
        alert('Fehler beim Mahnlauf: ' + (response.error || 'Unbekannter Fehler'));
      }
    } catch (error) {
      alert('Fehler beim Mahnlauf: ' + String(error));
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
        message: result.success ? 'Verbindung erfolgreich!' : (result.error || 'Test fehlgeschlagen'),
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

  const navItems = [
    { id: 'company', label: 'Stammdaten', icon: Building2, desc: 'Adresse & Kontakt' },
    { id: 'catalog', label: 'Kategorien', icon: Tags, desc: 'Produkte & Leistungen' },
    { id: 'finance', label: 'Finanzen', icon: Landmark, desc: 'Bank & Steuern' },
    { id: 'numbers', label: 'Nummernkreise', icon: FileDigit, desc: 'Rechnungs-, Angebots- & Kundennr.' },
    { id: 'email', label: 'E-Mail', icon: Mail, desc: 'SMTP & Resend' },
    { id: 'dunning', label: 'Mahnwesen', icon: Megaphone, desc: 'Mahnstufen & Gebühren' },
    { id: 'legal', label: 'Rechtliches', icon: Scale, desc: 'AGB & Steuerregeln' },
    { id: 'portal', label: 'Portal', icon: Globe, desc: 'Angebotslinks & Sync' },
    { id: 'system', label: 'System', icon: AlertCircle, desc: 'Backup & Audit' },
  ];

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'company':
        return (
          <div className="max-w-2xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">Unternehmensdaten</h3>
              <p className="text-gray-500 text-sm">Diese Informationen erscheinen im Kopf- und Fußbereich der Rechnung.</p>
            </div>

            <div className="grid grid-cols-1 gap-6">
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Firmenname</label>
                <input
                  type="text"
                  value={settings.company.name}
                  onChange={(e) => updateNested('company', 'name', e.target.value)}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-bold text-gray-900 focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Inhaber / Geschäftsführer</label>
                <input
                  type="text"
                  value={settings.company.owner}
                  onChange={(e) => updateNested('company', 'owner', e.target.value)}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Straße & Hausnr.</label>
                  <input
                    type="text"
                    value={settings.company.street}
                    onChange={(e) => updateNested('company', 'street', e.target.value)}
                    className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">PLZ</label>
                  <input
                    type="text"
                    value={settings.company.zip}
                    onChange={(e) => updateNested('company', 'zip', e.target.value)}
                    className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Stadt</label>
                <input
                  type="text"
                  value={settings.company.city}
                  onChange={(e) => updateNested('company', 'city', e.target.value)}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
              <div className="border-t border-gray-100 my-4"></div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">E-Mail Adresse</label>
                  <input
                    type="email"
                    value={settings.company.email}
                    onChange={(e) => updateNested('company', 'email', e.target.value)}
                    className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Telefon</label>
                  <input
                    type="text"
                    value={settings.company.phone}
                    onChange={(e) => updateNested('company', 'phone', e.target.value)}
                    className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Webseite</label>
                <input
                  type="text"
                  value={settings.company.website}
                  onChange={(e) => updateNested('company', 'website', e.target.value)}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
            </div>
          </div>
        );
      case 'catalog':
        return (
          <div className="max-w-2xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">Kategorien</h3>
              <p className="text-gray-500 text-sm">
                Kategorien für „Produkte & Leistungen“. Änderungen können beim Speichern automatisch in Artikeln
                übernommen werden.
              </p>
            </div>

            <div className="bg-gray-50 rounded-2xl p-6 border border-gray-100 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-sm uppercase flex items-center gap-2">
                  <Tags size={16} /> Kategorien
                </h4>
                <button
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
                  className="px-4 py-2 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 active:scale-95 transition-all flex items-center gap-2"
                >
                  <Plus size={16} /> Kategorie
                </button>
              </div>

              {(settings.catalog?.categories ?? []).length === 0 ? (
                <div className="p-4 bg-white rounded-2xl border border-gray-100 text-sm text-gray-500">
                  Noch keine Kategorien. Lege Kategorien an, damit du sie bei Artikeln auswählen kannst.
                </div>
              ) : (
                <div className="space-y-3">
                  {(settings.catalog?.categories ?? []).map((cat, idx) => (
                    <div key={cat.id} className="flex items-center gap-3 bg-white rounded-2xl p-3 border border-gray-100 animate-enter" style={{ animationDelay: `${idx * 50}ms` }}>
                      <div className="w-10 h-10 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">
                        {String(idx + 1).padStart(2, '0')}
                      </div>
                      <div className="flex-1">
                        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
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
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-bold outline-none focus:ring-2 focus:ring-accent"
                        />
                      </div>
                      <button
                        onClick={() => {
                          setSettings((prev) => {
                            const list = (prev.catalog?.categories ?? []).filter((c) => c.id !== cat.id);
                            return { ...prev, catalog: { categories: list } };
                          });
                        }}
                        className="w-10 h-10 rounded-full bg-error-bg text-error hover:bg-error-bg/80 transition-colors flex items-center justify-center"
                        title="Kategorie entfernen"
                      >
                        <Trash2 size={18} />
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
          <div className="max-w-2xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">Bankverbindung & Steuer</h3>
              <p className="text-gray-500 text-sm">Wichtig für den Zahlungsverkehr und die Pflichtangaben auf der Rechnung.</p>
            </div>

            <div className="bg-gray-50 rounded-2xl p-6 border border-gray-100">
              <h4 className="font-bold mb-4 flex items-center gap-2 text-sm uppercase">
                <Landmark size={16} /> Bankkonto
              </h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2">Bankname</label>
                  <input
                    type="text"
                    value={settings.finance.bankName}
                    onChange={(e) => updateNested('finance', 'bankName', e.target.value)}
                    className="w-full bg-white border border-gray-200 rounded-xl p-3 text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-2">IBAN</label>
                    <input
                      type="text"
                      value={settings.finance.iban}
                      onChange={(e) => updateNested('finance', 'iban', e.target.value)}
                      className="w-full bg-white border border-gray-200 rounded-xl p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none transition-shadow"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-2">BIC</label>
                    <input
                      type="text"
                      value={settings.finance.bic}
                      onChange={(e) => updateNested('finance', 'bic', e.target.value)}
                      className="w-full bg-white border border-gray-200 rounded-xl p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none transition-shadow"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Steuernummer</label>
                <input
                  type="text"
                  value={settings.finance.taxId}
                  onChange={(e) => updateNested('finance', 'taxId', e.target.value)}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">USt-IdNr.</label>
                <input
                  type="text"
                  value={settings.finance.vatId}
                  onChange={(e) => updateNested('finance', 'vatId', e.target.value)}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Registergericht / HRB</label>
              <input
                type="text"
                value={settings.finance.registerCourt}
                onChange={(e) => updateNested('finance', 'registerCourt', e.target.value)}
                placeholder="z.B. Amtsgericht Berlin HRB 12345"
                className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
              />
            </div>
          </div>
        );
      case 'numbers':
        return (
          <div className="max-w-2xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">Nummernkreise</h3>
              <p className="text-gray-500 text-sm">Definieren Sie das Format für Ihre Rechnungs-, Angebots- und Kundennummern.</p>
            </div>

            <div className="bg-black/5 rounded-3xl p-6 border border-black/5">
              <div className="flex justify-between items-start mb-6">
                <h4 className="font-bold flex items-center gap-2">
                  <FileDigit size={18} /> Rechnungen
                </h4>
                <div className="bg-white px-3 py-1 rounded-lg border border-gray-200 shadow-sm">
                  <span className="text-xs font-bold text-gray-400 uppercase mr-2">Vorschau:</span>
                  <span className="font-mono font-bold">{nextInvoicePreview}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Präfix Format</label>
                    <div className="group relative">
                      <HelpCircle size={12} className="text-gray-400 cursor-help" />
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-black text-white text-xs p-2 rounded pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        %Y = Aktuelles Jahr (z.B. 2023)
                      </div>
                    </div>
                  </div>
                  <input
                    type="text"
                    value={settings.numbers.invoicePrefix}
                    onChange={(e) => updateNested('numbers', 'invoicePrefix', e.target.value)}
                    className="w-full bg-white border-gray-200 rounded-xl p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Nächste Nummer</label>
                  <input
                    type="number"
                    value={settings.numbers.nextInvoiceNumber}
                    min={1}
                    onChange={(e) => updateNested(
                      'numbers',
                      'nextInvoiceNumber',
                      parsePositiveInteger(e.target.value, settings.numbers.nextInvoiceNumber),
                    )}
                    className="w-full bg-white border-gray-200 rounded-xl p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Mindestlänge (Padding)</label>
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
                  className="w-full accent-black h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-xs font-bold text-gray-400 mt-1">
                  <span>1</span>
                  <span>{settings.numbers.numberLength} Stellen (z.B. 001)</span>
                  <span>6</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-3xl p-6 border border-gray-100 opacity-70 hover:opacity-100 transition-opacity">
              <div className="flex justify-between items-start mb-6">
                <h4 className="font-bold flex items-center gap-2">
                  <FileDigit size={18} /> Angebote
                </h4>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Präfix Format</label>
                  <input
                    type="text"
                    value={settings.numbers.offerPrefix}
                    onChange={(e) => updateNested('numbers', 'offerPrefix', e.target.value)}
                    className="w-full bg-white border-gray-200 rounded-xl p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Nächste Nummer</label>
                  <input
                    type="number"
                    value={settings.numbers.nextOfferNumber}
                    min={1}
                    onChange={(e) => updateNested(
                      'numbers',
                      'nextOfferNumber',
                      parsePositiveInteger(e.target.value, settings.numbers.nextOfferNumber),
                    )}
                    className="w-full bg-white border-gray-200 rounded-xl p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-3xl p-6 border border-gray-100 opacity-70 hover:opacity-100 transition-opacity">
              <div className="flex justify-between items-start mb-6">
                <h4 className="font-bold flex items-center gap-2">
                  <FileDigit size={18} /> Kunden
                </h4>
                <div className="bg-white px-3 py-1 rounded-lg border border-gray-200 shadow-sm">
                  <span className="text-xs font-bold text-gray-400 uppercase mr-2">Vorschau:</span>
                  <span className="font-mono font-bold">{nextCustomerPreview}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Präfix Format</label>
                  <input
                    type="text"
                    value={settings.numbers.customerPrefix}
                    onChange={(e) => updateNested('numbers', 'customerPrefix', e.target.value)}
                    className="w-full bg-white border-gray-200 rounded-xl p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Nächste Nummer</label>
                  <input
                    type="number"
                    value={settings.numbers.nextCustomerNumber}
                    min={1}
                    onChange={(e) => updateNested(
                      'numbers',
                      'nextCustomerNumber',
                      parsePositiveInteger(e.target.value, settings.numbers.nextCustomerNumber),
                    )}
                    className="w-full bg-white border-gray-200 rounded-xl p-3 font-mono text-sm focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Mindestlänge (Padding)</label>
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
                  className="w-full accent-black h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-xs font-bold text-gray-400 mt-1">
                  <span>1</span>
                  <span>{settings.numbers.customerNumberLength} Stellen (z.B. 0001)</span>
                  <span>8</span>
                </div>
              </div>
            </div>
          </div>
        );
      case 'email':
        return (
          <div className="max-w-3xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">E-Mail Konfiguration</h3>
              <p className="text-gray-500 text-sm">Konfigurieren Sie SMTP oder Resend für den E-Mail-Versand.</p>
            </div>

            {/* Provider Selection */}
            <div className="bg-white border border-gray-200 rounded-2xl p-6">
              <h4 className="font-bold mb-4">E-Mail-Anbieter</h4>
              <div className="flex gap-3">
                <button
                  onClick={() => updateNested('email', 'provider', 'none')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all ${
                    settings.email.provider === 'none'
                      ? 'border-accent bg-accent/10'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="font-semibold">Kein Versand</div>
                  <div className="text-xs text-gray-500 mt-1">E-Mails deaktiviert</div>
                </button>
                <button
                  onClick={() => updateNested('email', 'provider', 'smtp')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all ${
                    settings.email.provider === 'smtp'
                      ? 'border-accent bg-accent/10'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="font-semibold">SMTP</div>
                  <div className="text-xs text-gray-500 mt-1">Eigener Mail-Server</div>
                </button>
                <button
                  onClick={() => updateNested('email', 'provider', 'resend')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all ${
                    settings.email.provider === 'resend'
                      ? 'border-accent bg-accent/10'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="font-semibold">Resend</div>
                  <div className="text-xs text-gray-500 mt-1">Transactional API</div>
                </button>
              </div>
            </div>

            {/* SMTP Configuration */}
            {settings.email.provider === 'smtp' && (
              <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
                <h4 className="font-bold">SMTP-Konfiguration</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-2">Server (Host)</label>
                    <input
                      type="text"
                      value={settings.email.smtpHost}
                      onChange={(e) => updateNested('email', 'smtpHost', e.target.value)}
                      placeholder="smtp.example.com"
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-2">Port</label>
                    <input
                      type="number"
                      value={settings.email.smtpPort}
                      onChange={(e) => updateNested('email', 'smtpPort', Number(e.target.value))}
                      placeholder="587"
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
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
                  <label className="block text-xs font-bold text-gray-500 mb-2">Benutzername</label>
                  <input
                    type="text"
                    value={settings.email.smtpUser}
                    onChange={(e) => updateNested('email', 'smtpUser', e.target.value)}
                    placeholder="user@example.com"
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2">Passwort</label>
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => {
                    setSmtpPassword(e.target.value);
                    setSmtpPasswordTouched(true);
                  }}
                  placeholder={smtpPasswordConfigured ? '•••••••• (gespeichert)' : '••••••••'}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                  <p className="text-xs text-gray-500 mt-1">Wird sicher im System-Keychain gespeichert</p>
                </div>
                <div>
                  <button
                    onClick={handleEmailTest}
                    disabled={
                      emailTesting ||
                      !settings.email.smtpHost ||
                      !settings.email.smtpUser ||
                      (!smtpPassword && !smtpPasswordConfigured)
                    }
                    className="px-4 py-2 bg-info text-white rounded-lg hover:bg-info/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {emailTesting ? 'Teste Verbindung...' : 'Verbindung testen'}
                  </button>
                  {emailTestStatus && (
                    <div className={`mt-3 p-3 rounded-lg ${emailTestStatus.success ? 'bg-success-bg text-success' : 'bg-error-bg text-error'}`}>
                      <p className="text-sm font-medium">{emailTestStatus.message}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Resend Configuration */}
            {settings.email.provider === 'resend' && (
              <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
                <h4 className="font-bold">Resend API-Konfiguration</h4>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2">API-Key</label>
                  <input
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
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                  <p className="text-xs text-gray-500 mt-1">Wird sicher im System-Keychain gespeichert</p>
                </div>
                <div>
                  <button
                    onClick={handleEmailTest}
                    disabled={emailTesting || (!resendApiKey && !resendApiKeyConfigured)}
                    className="px-4 py-2 bg-info text-white rounded-lg hover:bg-info/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {emailTesting ? 'Teste API-Key...' : 'API-Key testen'}
                  </button>
                  {emailTestStatus && (
                    <div className={`mt-3 p-3 rounded-lg ${emailTestStatus.success ? 'bg-success-bg text-success' : 'bg-error-bg text-error'}`}>
                      <p className="text-sm font-medium">{emailTestStatus.message}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sender Information */}
            {settings.email.provider !== 'none' && (
              <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
                <h4 className="font-bold">Absender-Informationen</h4>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2">Absender-Name</label>
                  <input
                    type="text"
                    value={settings.email.fromName}
                    onChange={(e) => updateNested('email', 'fromName', e.target.value)}
                    placeholder={settings.company.name || 'Meine Firma'}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2">Absender-E-Mail</label>
                  <input
                    type="email"
                    value={settings.email.fromEmail}
                    onChange={(e) => updateNested('email', 'fromEmail', e.target.value)}
                    placeholder={settings.company.email || 'info@example.com'}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
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
          <div className="max-w-4xl space-y-6 animate-enter">
            {/* Header */}
            <div className="flex items-end justify-between">
              <div>
                <h3 className="text-xl font-bold mb-1">Mahnwesen</h3>
                <p className="text-gray-500 text-sm">Automatische Zahlungserinnerungen und Mahnungen</p>
              </div>
            </div>

            {/* Master Enable/Disable Toggle */}
            <div
              className="bg-white border-2 border-gray-100 rounded-3xl p-6 hover:border-black transition-colors cursor-pointer"
              onClick={() => updateAutomation('dunningEnabled', !dunningEnabled)}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${dunningEnabled ? 'bg-black border-black' : 'border-gray-300'}`}
                >
                  {dunningEnabled && <CheckCircle size={14} className="text-accent" />}
                </div>
                <div>
                  <h4 className="font-bold text-sm">Mahnwesen aktivieren</h4>
                  <p className="text-xs text-gray-500 mt-1">Automatische Zahlungserinnerungen für überfällige Rechnungen</p>
                </div>
              </div>
            </div>

            {/* Email Provider Warning (if not configured) */}
            {dunningEnabled && settings.email.provider === 'none' && (
              <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3">
                <AlertTriangle size={18} className="text-orange-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-orange-900">E-Mail-Provider erforderlich</p>
                  <p className="text-xs text-orange-700 mt-1">
                    Konfigurieren Sie SMTP oder Resend im E-Mail-Tab, um Mahnungen versenden zu können.
                  </p>
                </div>
              </div>
            )}

            {/* Automation Settings Card (only when enabled) */}
            {dunningEnabled && (
              <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 space-y-5">
                <h4 className="font-bold flex items-center gap-2">
                  <Megaphone size={18} /> Automatisierung
                </h4>

                {/* Schedule Time */}
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Tägliche Ausführung um</label>
                  <input
                    type="time"
                    value={settings.automation?.dunningRunTime ?? '09:00'}
                    onChange={(e) => updateAutomation('dunningRunTime', e.target.value)}
                    className="w-48 bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-accent outline-none"
                  />
                </div>

                {/* Status Display */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white border border-gray-100 rounded-lg p-3">
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Letzter Lauf</label>
                    <p className="text-sm font-bold text-gray-900">
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
                  <div className="bg-white border border-gray-100 rounded-lg p-3">
                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Nächster Lauf</label>
                    <p className="text-sm font-bold text-gray-900">
                      {calculateNextRun(settings.automation?.dunningRunTime ?? '09:00')}
                    </p>
                  </div>
                </div>

                {/* Manual Trigger */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleManualDunningRun();
                  }}
                  disabled={dunningRunning || settings.email.provider === 'none' || activeLevelCount === 0}
                  className="w-full px-4 py-3 bg-orange-600 text-white rounded-xl hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-bold flex items-center justify-center gap-2"
                >
                  <Megaphone size={16} />
                  {dunningRunning ? 'Läuft...' : 'Jetzt manuell ausführen'}
                </button>
              </div>
            )}

            {/* Dunning Levels Configuration (only when enabled) */}
            {dunningEnabled && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold">Mahnstufen</h4>
                  <p className="text-sm text-gray-500">
                    {activeLevelCount} von {totalLevels} aktiv
                  </p>
                </div>

                {settings.dunning.levels.map((level, index) => (
                  <div
                    key={level.id}
                    className={`bg-white border rounded-xl overflow-hidden transition-all ${
                      level.enabled ? 'border-gray-200 hover:border-gray-300' : 'border-gray-100 opacity-50'
                    }`}
                  >
                    {/* Header with inline toggle */}
                    <div className="bg-gray-50 px-4 py-3 border-b flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* Individual Enable Toggle */}
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={level.enabled}
                            onChange={(e) => updateDunningLevel(index, 'enabled', e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 peer-focus:ring-2 peer-focus:ring-accent rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-black"></div>
                        </label>

                        <span className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs ${
                          level.enabled ? 'bg-black text-white' : 'bg-gray-300 text-gray-600'
                        }`}>
                          {level.id}
                        </span>
                        <h5 className="font-bold text-sm">{level.name}</h5>
                      </div>

                      {/* Quick edit inline */}
                      <div className="flex items-center gap-4 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500 font-medium">nach</span>
                          <input
                            type="number"
                            value={level.daysAfterDueDate}
                            onChange={(e) => updateDunningLevel(index, 'daysAfterDueDate', Number(e.target.value))}
                            disabled={!level.enabled}
                            className="w-14 bg-white border border-gray-200 rounded px-2 py-1 text-center font-bold focus:ring-2 focus:ring-accent outline-none disabled:opacity-50"
                          />
                          <span className="text-gray-500 font-medium">Tagen</span>
                        </div>
                        <div className="h-4 w-px bg-gray-300"></div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-gray-500 font-medium">Gebühr</span>
                          <input
                            type="number"
                            step="0.01"
                            value={level.fee}
                            onChange={(e) => updateDunningLevel(index, 'fee', Number(e.target.value))}
                            disabled={!level.enabled}
                            className="w-16 bg-white border border-gray-200 rounded px-2 py-1 text-center font-bold focus:ring-2 focus:ring-accent outline-none disabled:opacity-50"
                          />
                          <span className="text-gray-500 font-medium">€</span>
                        </div>
                      </div>
                    </div>

                    {/* Content (subject + text) */}
                    {level.enabled && (
                      <div className="p-4 space-y-3">
                        <div>
                          <label className="block text-[10px] font-bold text-gray-500 mb-1.5 uppercase tracking-wide">Betreff</label>
                          <input
                            type="text"
                            value={level.subject}
                            onChange={(e) => updateDunningLevel(index, 'subject', e.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                            placeholder="z.B. Zahlungserinnerung für Rechnung %N"
                          />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide">Einleitungstext</label>
                            <button
                              onClick={() => {
                                setPreviewLevelIndex(index);
                                setPreviewModalOpen(true);
                              }}
                              className="px-2.5 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] font-bold transition-colors"
                            >
                              Vorschau
                            </button>
                          </div>
                          <textarea
                            rows={2}
                            value={level.text}
                            onChange={(e) => updateDunningLevel(index, 'text', e.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none"
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
                                <button
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
                                  className={`px-1.5 py-1 rounded text-[10px] font-bold transition-colors ${
                                    ph.present
                                      ? 'bg-success-bg text-success'
                                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  }`}
                                  title={`${ph.label} einfügen`}
                                >
                                  {ph.code}
                                </button>
                              ))}
                            </div>
                            {(!level.text.includes('%N') || !level.text.includes('%A')) && (
                              <div className="flex items-center gap-1 text-orange-600">
                                <AlertTriangle size={12} />
                                <span className="text-[10px] font-medium">%N und %A empfohlen</span>
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
              <div className="text-center py-12 text-gray-400">
                <Megaphone size={48} className="mx-auto mb-4 opacity-30" />
                <p>Aktivieren Sie das Mahnwesen, um Mahnstufen zu konfigurieren</p>
              </div>
            )}

            {/* Recurring Invoices Section */}
            <div className="border-t border-gray-200 pt-8 mt-8">
              <div className="mb-6">
                <h3 className="text-xl font-bold mb-1 flex items-center gap-2">
                  <Repeat size={22} /> Automatische Abo-Rechnungen
                </h3>
                <p className="text-gray-500 text-sm">Automatische Generierung wiederkehrender Rechnungen</p>
              </div>

              {/* Master Enable/Disable Toggle */}
              <div
                className="bg-white border-2 border-gray-100 rounded-3xl p-6 hover:border-black transition-colors cursor-pointer"
                onClick={() => updateAutomation('recurringEnabled', !settings.automation.recurringEnabled)}
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.automation.recurringEnabled ? 'bg-black border-black' : 'border-gray-300'}`}
                  >
                    {settings.automation.recurringEnabled && <CheckCircle size={14} className="text-accent" />}
                  </div>
                  <div>
                    <h4 className="font-bold text-sm">Automatische Generierung aktivieren</h4>
                    <p className="text-xs text-gray-500 mt-1">Abo-Rechnungen werden automatisch zum festgelegten Zeitpunkt erstellt</p>
                  </div>
                </div>
              </div>

              {/* Automation Settings Card (only when enabled) */}
              {settings.automation.recurringEnabled && (
                <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 space-y-5 mt-4">
                  <h4 className="font-bold flex items-center gap-2">
                    <Repeat size={18} /> Automatisierung
                  </h4>

                  {/* Schedule Time */}
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Tägliche Ausführung um</label>
                    <input
                      type="time"
                      value={settings.automation?.recurringRunTime ?? '03:00'}
                      onChange={(e) => updateAutomation('recurringRunTime', e.target.value)}
                      className="w-48 bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-accent outline-none"
                    />
                    <p className="text-xs text-gray-500 mt-2">
                      Empfohlen: 03:00 Uhr (nachts, um Konflikte mit Mahnlauf zu vermeiden)
                    </p>
                  </div>

                  {/* Status Display */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white border border-gray-100 rounded-lg p-3">
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Letzter Lauf</label>
                      <p className="text-sm font-bold text-gray-900">
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
                    <div className="bg-white border border-gray-100 rounded-lg p-3">
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Nächster Lauf</label>
                      <p className="text-sm font-bold text-gray-900">
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
          <div className="max-w-2xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">Rechtliches & Texte</h3>
              <p className="text-gray-500 text-sm">Steuerliche Einstellungen und Standardtexte.</p>
            </div>

            <div
              className="bg-white border-2 border-gray-100 rounded-3xl p-6 hover:border-black transition-colors cursor-pointer"
              onClick={() => updateNested('legal', 'smallBusinessRule', !settings.legal.smallBusinessRule)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.legal.smallBusinessRule ? 'bg-black border-black' : 'border-gray-300'}`}
                  >
                    {settings.legal.smallBusinessRule && <CheckCircle size={14} className="text-accent" />}
                  </div>
                  <div>
                    <h4 className="font-bold text-sm">Kleinunternehmerregelung anwenden</h4>
                    <p className="text-xs text-gray-500 mt-1">Keine Umsatzsteuerberechnung gem. § 19 UStG.</p>
                  </div>
                </div>
              </div>
            </div>

            <div
              className="bg-white border-2 border-gray-100 rounded-3xl p-6 hover:border-black transition-colors cursor-pointer"
              onClick={() => updateNested('eInvoice', 'enabled', !settings.eInvoice.enabled)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${settings.eInvoice.enabled ? 'bg-black border-black' : 'border-gray-300'}`}
                  >
                    {settings.eInvoice.enabled && <CheckCircle size={14} className="text-accent" />}
                  </div>
                  <div>
                    <h4 className="font-bold text-sm">ZUGFeRD Export für Rechnungen aktivieren</h4>
                    <p className="text-xs text-gray-500 mt-1">
                      Exportiert Rechnungen als ZUGFeRD EN16931 (Profil {settings.eInvoice.profile}, Version {settings.eInvoice.version}).
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className={settings.legal.smallBusinessRule ? 'opacity-30 pointer-events-none' : ''}>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Standard Umsatzsteuer (%)</label>
                <input
                  type="number"
                  value={settings.legal.defaultVatRate}
                  onChange={(e) => updateNested('legal', 'defaultVatRate', parseFloat(e.target.value))}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-bold text-gray-900 focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Zahlungsziel (Tage)</label>
                <input
                  type="number"
                  value={settings.legal.paymentTermsDays}
                  onChange={(e) => updateNested('legal', 'paymentTermsDays', parseInt(e.target.value))}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-bold text-gray-900 focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-3xl p-6">
              <h4 className="font-bold text-sm mb-2">Umsatzsteuer-Basis (Dashboard)</h4>
              <p className="text-xs text-gray-500 mb-4">
                Soll: basiert auf gestellten Rechnungen (Status ≠ Entwurf) nach Rechnungsdatum. Ist: basiert auf erfassten Zahlungen nach Zahlungsdatum.
              </p>
              <div className="flex items-center gap-2 bg-gray-100/80 p-1.5 rounded-full border border-gray-200 w-fit">
                {(['soll', 'ist'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => updateNested('legal', 'taxAccountingMethod', m)}
                    className={`px-5 py-2 rounded-full text-xs font-bold transition-all ${
                      (settings.legal.taxAccountingMethod ?? 'soll') === m
                        ? 'bg-black text-white shadow-md'
                        : 'text-gray-500 hover:bg-white hover:text-black hover:shadow-sm'
                    }`}
                  >
                    {m === 'soll' ? 'Soll' : 'Ist'}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-gray-100 pt-6">
              <h4 className="font-bold text-sm mb-4">Standardtexte</h4>

              <div className="mb-6">
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Einleitungstext (Standard)</label>
                <textarea
                  value={settings.legal.defaultIntroText}
                  onChange={(e) => updateNested('legal', 'defaultIntroText', e.target.value)}
                  rows={3}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none transition-shadow"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Fußzeilentext (Zusatz)</label>
                <textarea
                  value={settings.legal.defaultFooterText}
                  onChange={(e) => updateNested('legal', 'defaultFooterText', e.target.value)}
                  rows={2}
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none transition-shadow"
                />
              </div>
            </div>
          </div>
        );
      case 'portal':
        return (
          <div className="max-w-2xl space-y-8 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">Offer Portal</h3>
              <p className="text-gray-500 text-sm">Angebotslinks veröffentlichen und Status synchronisieren.</p>
            </div>

            <div className="bg-white border-2 border-gray-100 rounded-3xl p-6 space-y-6">
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Portal Base URL</label>
                <input
                  type="text"
                  value={settings.portal.baseUrl}
                  onChange={(e) => updateNested('portal', 'baseUrl', e.target.value)}
                  placeholder="https://offers.example.com"
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-bold text-gray-900 focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
                <p className="text-xs text-gray-400 mt-2">Tipp: Setup-Seite im Portal: <span className="font-mono">/admin/setup</span></p>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase tracking-wide">Publish API Key (optional)</label>
                <input
                  type="password"
                  value={portalApiKey}
                  onChange={(e) => {
                    setPortalApiKey(e.target.value);
                    setPortalApiKeyTouched(true);
                  }}
                  placeholder={
                    portalApiKeyConfigured
                      ? '(gespeichert im OS Keychain, zum Ersetzen eingeben)'
                      : '(im OS Keychain gespeichert)'
                  }
                  className="w-full bg-gray-50 border-gray-200 rounded-xl p-4 font-bold text-gray-900 focus:ring-2 focus:ring-accent outline-none transition-shadow"
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3 items-center">
                <button
                  onClick={async () => {
                    try {
                      setPortalTestStatus('Prüfe Verbindung...');
                      const baseUrl = settings.portal.baseUrl.trim();
                      if (!baseUrl) throw new Error('Base URL fehlt');
                      const res = await ipc.portal.health({ baseUrl });
                      setPortalTestStatus(res.ok ? `OK (${res.ts})` : 'Fehler');
                    } catch (e) {
                      setPortalTestStatus(`Fehler: ${String(e)}`);
                    }
                  }}
                  className="px-5 py-3 rounded-xl font-bold bg-white border border-gray-200 hover:bg-gray-100 transition-colors w-full sm:w-auto"
                >
                  Verbindung testen
                </button>
                <div className="flex-1 text-sm font-medium text-gray-500 w-full">
                  {portalTestStatus}
                </div>
              </div>
            </div>
          </div>
        );
      case 'system':
        return (
          <div className="max-w-2xl space-y-10 animate-enter">
            <div>
              <h3 className="text-xl font-bold mb-1">System</h3>
              <p className="text-gray-500 text-sm">Audit-Log, Backup und Wiederherstellung.</p>
            </div>

            <div className="bg-gray-50 rounded-3xl p-6 border border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h4 className="text-lg font-bold text-gray-900">Audit</h4>
                <p className="text-sm text-gray-500">Audit-Log prüfen und als CSV exportieren.</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={async () => {
                    const result = await ipc.audit.verify();
                    alert(JSON.stringify(result, null, 2));
                  }}
                  className="px-5 py-3 rounded-xl font-bold bg-white border border-gray-200 hover:bg-gray-100 transition-colors"
                >
                  Verify
                </button>
                <button
                  onClick={async () => {
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
                  }}
                  className="px-5 py-3 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
                >
                  Export CSV
                </button>
              </div>
            </div>

            <div className="bg-gray-50 rounded-3xl p-6 border border-gray-100 space-y-4">
              <div>
                <h4 className="text-lg font-bold text-gray-900">Backup</h4>
                <p className="text-sm text-gray-500">
                  Datenbank sichern oder aus einer Sicherung wiederherstellen.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={async () => {
                    try {
                      const res = await ipc.db.backup();
                      alert(`Backup erstellt:\n${res.path}`);
                    } catch (e) {
                      alert(`Backup fehlgeschlagen: ${String(e)}`);
                    }
                  }}
                  className="px-5 py-3 rounded-xl font-bold bg-white border border-gray-200 hover:bg-gray-100 transition-colors"
                >
                  Backup erstellen
                </button>

                <div className="flex-1 flex gap-2">
                  <input
                    value={backupPath}
                    onChange={(e) => setBackupPath(e.target.value)}
                    placeholder="Pfad zur .sqlite Sicherung..."
                    className="flex-1 bg-white border border-gray-200 rounded-xl p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent"
                  />
                  <button
                    onClick={async () => {
                      try {
                        const res = await ipc.db.restore({ path: backupPath.trim() });
                        alert(`Restore abgeschlossen:\n${JSON.stringify(res, null, 2)}`);
                      } catch (e) {
                        alert(`Restore fehlgeschlagen: ${String(e)}`);
                      }
                    }}
                    className="px-5 py-3 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
                  >
                    Restore
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-white rounded-[2.5rem] shadow-sm min-h-full flex overflow-hidden relative animate-enter">
      
      {/* Toast */}
      {showSaveToast && (
        <div className="absolute top-8 right-8 bg-black text-accent px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 z-50 animate-in fade-in slide-in-from-top-4">
          <CheckCircle size={18} />
          <span className="font-bold text-sm">Einstellungen gespeichert!</span>
        </div>
      )}

      {/* Sidebar Navigation */}
      <div className="w-72 bg-gray-50 border-r border-gray-100 p-8 flex flex-col">
        <h2 className="text-2xl font-black mb-8">Einstellungen</h2>
        <nav className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as any)}
                className={`w-full text-left p-4 rounded-2xl flex items-center gap-4 transition-all duration-300 group animate-enter ${
                  isActive
                    ? 'bg-white shadow-md ring-1 ring-black/5'
                    : 'hover:bg-white hover:shadow-sm'
                }`}
                style={{ animationDelay: `${navItems.findIndex(n => n.id === item.id) * 30}ms` }}
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                  isActive ? 'bg-black text-accent' : 'bg-gray-200 text-gray-500 group-hover:text-gray-700'
                }`}>
                  <Icon size={20} />
                </div>
                <div>
                  <div className={`font-bold text-sm ${isActive ? 'text-black' : 'text-gray-600'}`}>
                    {item.label}
                  </div>
                  <div className="text-[10px] font-medium text-gray-400">
                    {item.desc}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>
        
        <div className="mt-auto">
             <div className="bg-accent/20 p-4 rounded-2xl border border-accent/50">
                 <div className="flex items-start gap-3">
                     <AlertCircle size={18} className="text-black shrink-0 mt-0.5" />
                     <p className="text-xs text-black/80 font-medium">Alle Änderungen wirken sich sofort auf neue Dokumente aus.</p>
                 </div>
             </div>
        </div>
      </div>

      {/* Main Content Form */}
      <div className="flex-1 flex flex-col h-full">
         <div className="flex-1 overflow-y-auto p-8 lg:p-12">

            {renderActiveTab()}
            
         </div>

         {/* Footer Actions */}
         <div className="p-8 border-t border-gray-100 flex justify-end bg-white rounded-b-[2.5rem]">
             <button 
                onClick={handleSave}
                className="bg-black text-accent px-8 py-3 rounded-xl font-bold text-sm hover:scale-105 active:scale-95 transition-all flex items-center gap-2 shadow-xl shadow-black/10"
             >
                 <Save size={18} />
                 Einstellungen speichern
             </button>
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
