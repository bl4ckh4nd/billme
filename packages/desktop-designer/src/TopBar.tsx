import React from 'react';
import {
  ArrowLeft,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Grid3x3,
  Magnet,
  ShieldCheck,
  Printer,
  Save,
  Copy,
} from 'lucide-react';

export interface TopBarProps {
  templateName: string;
  onRenameTemplate: (name: string) => void;
  templateType: 'invoice' | 'offer';
  onBack: () => void;

  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (z: number) => void;
  onFit: () => void;
  onReset: () => void;

  gridEnabled: boolean;
  onToggleGrid: () => void;
  gridSize: number; // px
  onGridSize: (px: number) => void;
  mmToPx: number;
  snapEnabled: boolean;
  onToggleSnap: () => void;

  onSave: () => void;
  onSaveCopy: () => void;
  saving: boolean;
  onLegalCheck: () => void;
  onExport: () => void;
}

const ToolButton: React.FC<{
  onClick?: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, active, disabled, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    disabled={disabled}
    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
      active ? 'bg-accent text-black' : 'text-dark-muted hover:bg-dark-2 hover:text-white'
    }`}
  >
    {children}
  </button>
);

const Divider = () => <div className="mx-1 h-5 w-px bg-dark-border-subtle" />;

export const TopBar: React.FC<TopBarProps> = ({
  templateName,
  onRenameTemplate,
  templateType,
  onBack,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFit,
  onReset,
  gridEnabled,
  onToggleGrid,
  gridSize,
  onGridSize,
  mmToPx,
  snapEnabled,
  onToggleSnap,
  onSave,
  onSaveCopy,
  saving,
  onLegalCheck,
  onExport,
}) => {
  const gridMm = Math.round((gridSize / mmToPx) * 10) / 10;

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-dark-border bg-dark-1 px-3 no-print">
      {/* Left: back + name */}
      <button
        onClick={onBack}
        title="Zurück zur Übersicht"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-dark-muted hover:bg-dark-2 hover:text-white transition-colors"
      >
        <ArrowLeft size={16} />
      </button>
      <span
        className={`hidden md:inline rounded px-2 py-1 text-[10px] font-bold uppercase tracking-widest ${
          templateType === 'offer' ? 'bg-purple-900 text-purple-200' : 'bg-dark-2 text-dark-muted'
        }`}
      >
        {templateType === 'offer' ? 'Angebot' : 'Rechnung'}
      </span>
      <input
        value={templateName}
        onChange={(e) => onRenameTemplate(e.target.value)}
        placeholder={templateType === 'offer' ? 'Angebotsvorlage' : 'Rechnungsvorlage'}
        className="w-40 lg:w-56 rounded-lg border border-transparent bg-dark-2 px-3 py-1.5 text-sm font-semibold text-white outline-none transition-colors placeholder-gray-600 hover:border-dark-border-subtle focus:border-accent"
      />

      <Divider />

      {/* History */}
      <ToolButton title="Rückgängig (Strg+Z)" onClick={onUndo} disabled={!canUndo}>
        <Undo2 size={16} />
      </ToolButton>
      <ToolButton title="Wiederholen (Strg+Umschalt+Z)" onClick={onRedo} disabled={!canRedo}>
        <Redo2 size={16} />
      </ToolButton>

      <Divider />

      {/* Zoom */}
      <ToolButton title="Verkleinern (Strg+-)" onClick={onZoomOut}>
        <ZoomOut size={16} />
      </ToolButton>
      <button
        onClick={onReset}
        title="Auf 100% zurücksetzen (Strg+0)"
        className="h-8 min-w-14 rounded-lg px-1 text-xs font-mono font-semibold text-white hover:bg-dark-2 transition-colors tabular-nums"
      >
        {Math.round(zoom * 100)}%
      </button>
      <ToolButton title="Vergrößern (Strg++)" onClick={onZoomIn}>
        <ZoomIn size={16} />
      </ToolButton>
      <ToolButton title="An Fenster anpassen (Umschalt+1)" onClick={onFit}>
        <Maximize size={16} />
      </ToolButton>
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v) onZoomTo(Number(v));
          e.currentTarget.value = '';
        }}
        title="Zoom-Voreinstellung"
        className="h-8 rounded-lg border border-dark-border-subtle bg-dark-2 px-1 text-xs text-dark-muted outline-none hover:border-dark-border focus:border-accent"
      >
        <option value="">Zoom…</option>
        <option value="0.25">25%</option>
        <option value="0.5">50%</option>
        <option value="0.75">75%</option>
        <option value="1">100%</option>
        <option value="1.5">150%</option>
        <option value="2">200%</option>
      </select>

      <Divider />

      {/* Grid + snap */}
      <ToolButton title={gridEnabled ? 'Raster ausblenden' : 'Raster einblenden'} onClick={onToggleGrid} active={gridEnabled}>
        <Grid3x3 size={16} />
      </ToolButton>
      {gridEnabled && (
        <select
          value={gridMm}
          onChange={(e) => onGridSize(Number(e.target.value) * mmToPx)}
          title="Rastergröße"
          className="h-8 rounded-lg border border-dark-border-subtle bg-dark-2 px-1 text-xs text-dark-muted outline-none hover:border-dark-border focus:border-accent"
        >
          <option value={2.5}>2,5 mm</option>
          <option value={5}>5 mm</option>
          <option value={10}>10 mm</option>
        </select>
      )}
      <ToolButton title={snapEnabled ? 'Einrasten aus (Alt gedrückt halten)' : 'Einrasten an'} onClick={onToggleSnap} active={snapEnabled}>
        <Magnet size={16} />
      </ToolButton>

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onLegalCheck}
          title="DIN & Pflichtangaben prüfen"
          className="flex h-8 items-center gap-1.5 rounded-lg border border-dark-border-subtle bg-dark-2 px-3 text-xs font-bold text-dark-muted hover:border-dark-border hover:text-white transition-colors"
        >
          <ShieldCheck size={14} className="text-success" />
          <span className="hidden lg:inline">Rechts-Check</span>
        </button>
        <button
          onClick={onExport}
          title="Als PDF exportieren"
          className="flex h-8 items-center gap-1.5 rounded-lg border border-dark-border-subtle bg-dark-2 px-3 text-xs font-bold text-dark-muted hover:border-dark-border hover:text-white transition-colors"
        >
          <Printer size={14} />
          <span className="hidden lg:inline">PDF</span>
        </button>
        <ToolButton title="Als Kopie speichern" onClick={onSaveCopy} disabled={saving}>
          <Copy size={16} />
        </ToolButton>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-bold text-black hover:bg-accent-hover transition-transform active:scale-95 disabled:opacity-50"
        >
          <Save size={14} />
          Speichern
        </button>
      </div>
    </div>
  );
};
