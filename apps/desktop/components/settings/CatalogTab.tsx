import React from 'react';
import { Tags, Plus, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { AppSettings } from '../../types';

interface CatalogTabProps {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
}

export const CatalogTab: React.FC<CatalogTabProps> = ({ settings, setSettings }) => {
  return (
    <div className="max-w-2xl space-y-8 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">Kategorien</h3>
        <p className="text-muted text-sm">
          Kategorien für „Produkte & Leistungen". Änderungen können beim Speichern automatisch in Artikeln
          übernommen werden.
        </p>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle space-y-4">
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
            className="px-4 py-2 bg-foreground text-white rounded-full text-xs font-bold hover:bg-dark-1 active:scale-95 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-200 ease-out flex items-center gap-2"
          >
            <Plus size={16} /> Kategorie
          </button>
        </div>

        {(settings.catalog?.categories ?? []).length === 0 ? (
          <div className="p-4 bg-surface rounded-lg border border-border-subtle text-sm text-muted">
            Noch keine Kategorien. Lege Kategorien an, damit du sie bei Artikeln auswählen kannst.
          </div>
        ) : (
          <div className="space-y-3">
            {(settings.catalog?.categories ?? []).map((cat, idx) => (
              <div key={cat.id} className="flex items-center gap-3 bg-surface rounded-lg p-3 border border-border-subtle animate-enter" style={{ animationDelay: `${idx * 50}ms` }}>
                <div className="w-10 h-10 rounded-md bg-surface-muted border border-border-subtle flex items-center justify-center text-xs font-bold text-muted">
                  {String(idx + 1).padStart(2, '0')}
                </div>
                <div className="flex-1">
                  <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
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
                    className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-bold outline-none focus:ring-2 focus:ring-accent transition-shadow duration-200 ease-out"
                  />
                </div>
                <button
                  onClick={() => {
                    setSettings((prev) => {
                      const list = (prev.catalog?.categories ?? []).filter((c) => c.id !== cat.id);
                      return { ...prev, catalog: { categories: list } };
                    });
                  }}
                  className="w-10 h-10 rounded-full bg-error-bg text-error hover:bg-error-bg/80 transition-colors duration-200 ease-out flex items-center justify-center"
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
};
