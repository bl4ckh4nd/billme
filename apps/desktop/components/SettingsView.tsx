

import React, { useState } from 'react';
import {
  Building2, Landmark, FileDigit, Scale,
  Save, CheckCircle, AlertCircle, Megaphone, Globe, Tags, Mail
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
import { CompanyTab } from './settings/CompanyTab';
import { CatalogTab } from './settings/CatalogTab';
import { FinanceTab } from './settings/FinanceTab';
import { NumbersTab } from './settings/NumbersTab';
import { EmailTab } from './settings/EmailTab';
import { DunningTab } from './settings/DunningTab';
import { LegalTab } from './settings/LegalTab';
import { PortalTab } from './settings/PortalTab';
import { SystemTab } from './settings/SystemTab';

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
        ...(prev[section] as Record<string, unknown>),
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
        return <CompanyTab settings={settings} updateNested={updateNested} />;
      case 'catalog':
        return <CatalogTab settings={settings} setSettings={setSettings} />;
      case 'finance':
        return <FinanceTab settings={settings} updateNested={updateNested} />;
      case 'numbers':
        return <NumbersTab settings={settings} updateNested={updateNested} />;
      case 'email':
        return (
          <EmailTab
            settings={settings}
            updateNested={updateNested}
            smtpPassword={smtpPassword}
            setSmtpPassword={setSmtpPassword}
            smtpPasswordConfigured={smtpPasswordConfigured}
            setSmtpPasswordTouched={setSmtpPasswordTouched}
            resendApiKey={resendApiKey}
            setResendApiKey={setResendApiKey}
            resendApiKeyConfigured={resendApiKeyConfigured}
            setResendApiKeyTouched={setResendApiKeyTouched}
            emailTestStatus={emailTestStatus}
            setEmailTestStatus={setEmailTestStatus}
            emailTesting={emailTesting}
            handleEmailTest={handleEmailTest}
          />
        );
      case 'dunning':
        return (
          <DunningTab
            settings={settings}
            updateAutomation={updateAutomation}
            updateDunningLevel={updateDunningLevel}
            calculateNextRun={calculateNextRun}
            handleManualDunningRun={handleManualDunningRun}
            dunningRunning={dunningRunning}
            setPreviewModalOpen={setPreviewModalOpen}
            setPreviewLevelIndex={setPreviewLevelIndex}
          />
        );
      case 'legal':
        return <LegalTab settings={settings} updateNested={updateNested} />;
      case 'portal':
        return (
          <PortalTab
            settings={settings}
            updateNested={updateNested}
            portalApiKey={portalApiKey}
            setPortalApiKey={setPortalApiKey}
            portalApiKeyConfigured={portalApiKeyConfigured}
            setPortalApiKeyTouched={setPortalApiKeyTouched}
            portalTestStatus={portalTestStatus}
            setPortalTestStatus={setPortalTestStatus}
          />
        );
      case 'system':
        return <SystemTab backupPath={backupPath} setBackupPath={setBackupPath} />;
      default:
        return null;
    }
  };

  return (
    <div className="bg-surface rounded-2xl shadow-sm min-h-full flex overflow-hidden relative animate-enter">

      {/* Toast */}
      {showSaveToast && (
        <div className="absolute top-8 right-8 bg-black text-accent px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 z-50 animate-in fade-in slide-in-from-top-4">
          <CheckCircle size={18} />
          <span className="font-bold text-sm">Einstellungen gespeichert!</span>
        </div>
      )}

      {/* Sidebar Navigation */}
      <div className="w-72 bg-surface-muted border-r border-border-subtle p-8 flex flex-col">
        <h2 className="text-2xl font-black mb-8">Einstellungen</h2>
        <nav className="space-y-5">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2 px-1">{group.label}</p>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id as any)}
                      className={`w-full text-left p-3 rounded-xl flex items-center gap-3 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out group ${
                        isActive
                          ? 'bg-surface shadow-md ring-1 ring-black/5'
                          : 'hover:bg-surface hover:shadow-sm'
                      }`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors duration-200 ease-out shrink-0 ${
                        isActive ? 'bg-foreground text-accent' : 'bg-canvas text-muted group-hover:text-foreground'
                      }`}>
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0">
                        <div className={`font-bold text-sm truncate ${isActive ? 'text-foreground' : 'text-muted'}`}>
                          {item.label}
                        </div>
                        <div className="text-[10px] font-medium text-muted truncate">
                          {item.desc}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto">
             <div className="bg-accent/20 p-4 rounded-xl border border-accent/50">
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
         <div className="p-8 border-t border-border-subtle flex justify-end bg-surface rounded-b-2xl">
             <button
                onClick={handleSave}
                className="bg-foreground text-accent px-8 py-3 rounded-xl font-bold text-sm hover:scale-105 active:scale-95 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out flex items-center gap-2 shadow-xl shadow-black/10"
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
