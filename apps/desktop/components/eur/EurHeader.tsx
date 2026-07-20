import React from 'react';
import { Button } from '@billme/ui';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Download, ReceiptText, Settings2 } from 'lucide-react';

type Props = {
  taxYear: number;
  onTaxYearChange: (year: number) => void;
  onRulesClick: () => void;
  onCsvExport: () => void;
  onPdfExport: () => void;
  isPdfExporting: boolean;
};

export const EurHeader: React.FC<Props> = ({
  taxYear,
  onTaxYearChange,
  onRulesClick,
  onCsvExport,
  onPdfExport,
  isPdfExporting,
}) => {
  const navigate = useNavigate();

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate({ to: '/finance' })}
          className="p-2 hover:bg-canvas rounded-lg transition-colors ease-out duration-150"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="w-12 h-12 rounded-xl bg-foreground text-accent flex items-center justify-center">
          <ReceiptText size={22} />
        </div>
        <div>
          <h2 className="text-2xl font-black text-foreground">Anlage EÜR</h2>
          <p className="text-sm text-muted mt-1">Klassifizierung und Auswertung für Steuerjahr {taxYear}.</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <select
          value={taxYear}
          onChange={(e) => onTaxYearChange(Number(e.target.value))}
          className="rounded-lg border border-border px-3 py-2 text-sm"
        >
          <option value={2025}>2025</option>
        </select>
        <Button variant="secondary" size="sm" onClick={onRulesClick}>
          <Settings2 size={16} />
          Regeln
        </Button>
        <Button variant="dark" size="sm" onClick={onCsvExport}>
          <Download size={16} />
          CSV exportieren
        </Button>
        <Button variant="dark" size="sm" onClick={onPdfExport} disabled={isPdfExporting}>
          <Download size={16} />
          {isPdfExporting ? 'PDF...' : 'PDF exportieren'}
        </Button>
      </div>
    </div>
  );
};
