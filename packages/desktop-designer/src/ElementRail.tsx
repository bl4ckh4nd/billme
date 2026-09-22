import React from 'react';
import { ElementType } from './types';
import { Type, Image as ImageIcon, Box, Table, Minus, QrCode } from 'lucide-react';

export interface ElementRailProps {
  onAddElement: (type: ElementType) => void;
}

const ITEMS: { type: ElementType; icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; label: string }[] = [
  { type: ElementType.TEXT, icon: Type, label: 'Text' },
  { type: ElementType.IMAGE, icon: ImageIcon, label: 'Bild' },
  { type: ElementType.TABLE, icon: Table, label: 'Tabelle' },
  { type: ElementType.BOX, icon: Box, label: 'Box' },
  { type: ElementType.LINE, icon: Minus, label: 'Linie' },
  { type: ElementType.QRCODE, icon: QrCode, label: 'GiroCode' },
];

/** Left rail of insertable element types. */
export const ElementRail: React.FC<ElementRailProps> = ({ onAddElement }) => (
  <div className="flex w-20 shrink-0 flex-col items-center gap-2 border-r border-dark-border bg-dark-1 py-3 no-print">
    <span className="mb-1 text-xs font-bold uppercase tracking-widest text-dark-muted">Einfügen</span>
    {ITEMS.map((item) => (
      <button
        key={item.type}
        onClick={() => onAddElement(item.type)}
        title={`${item.label} hinzufügen`}
        className="group flex w-16 flex-col items-center gap-1 rounded-xl border border-dark-border-subtle bg-dark-2 py-2 text-dark-muted motion-safe:transition-colors motion-reduce:transition-none hover:border-accent hover:bg-accent hover:text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
      >
        <item.icon size={20} strokeWidth={1.5} />
        <span className="text-xs font-semibold">{item.label}</span>
      </button>
    ))}
  </div>
);
