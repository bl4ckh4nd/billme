import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Canonical designer element model (shared by Lite + Pro desktop apps).
// These were previously duplicated byte-for-byte in apps/*/types.ts; the
// apps now re-export them from here so there is a single source of truth.
// ---------------------------------------------------------------------------

export enum ElementType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  BOX = 'BOX',
  TABLE = 'TABLE',
  LINE = 'LINE',
  QRCODE = 'QRCODE',
}

export interface ElementStyle {
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  textAlign?: 'left' | 'center' | 'right';
  color?: string;
  backgroundColor?: string;
  borderWidth?: number;
  borderColor?: string;
  width?: number; // in px
  height?: number; // in px
  borderRadius?: number;
  padding?: number;
  fontFamily?: string;
  textDecoration?: 'none' | 'underline' | 'line-through';
  opacity?: number; // 0..1
  lineHeight?: number;
  letterSpacing?: number;
}

export interface TableColumn {
  id: string;
  label: string;
  width: number; // px
  visible: boolean;
  align: 'left' | 'center' | 'right';
}

export interface TableRow {
  id: string;
  cells: string[];
}

export interface InvoiceElement {
  id: string;
  type: ElementType | 'TEXT' | 'IMAGE' | 'BOX' | 'TABLE' | 'LINE' | 'QRCODE';
  x: number;
  y: number;
  zIndex: number;
  content?: string; // For text
  src?: string; // For images
  tableData?: {
    columns: TableColumn[];
    rows: TableRow[];
  };
  qrData?: {
    iban: string;
    bic: string;
    amount: number; // 0 for dynamic
    reference: string;
  };
  style: ElementStyle;
  label?: string; // Internal label (e.g. "address_field")
  locked?: boolean; // Layer lock (skip selection/drag)
  hidden?: boolean; // Layer visibility toggle
}

export interface SnapGuide {
  orientation: 'vertical' | 'horizontal';
  position: number;
  label?: string;
}

export type DocumentTemplateKind = 'invoice' | 'offer';

export interface DocumentTemplate {
  id: string;
  kind: DocumentTemplateKind;
  name: string;
  elements: InvoiceElement[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Injectable, app-specific configuration. The designer is implemented once in
// this package; each app injects its data hooks, DIN zones, variable groups,
// placeholder renderer and legal-check rules via these props/types.
// ---------------------------------------------------------------------------

export interface DinZone {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VariableItem {
  key: string;
  label: string;
  description?: string;
}

export interface VariableGroup {
  title: string;
  variables: VariableItem[];
}

/** Renders raw template text (with {{placeholders}}) into React nodes. */
export type RenderText = (content: string) => ReactNode;

/** A legal/compliance check: returns a list of issue messages (empty = OK). */
export type LegalRule = (elements: InvoiceElement[]) => string[];

export interface DesignerConfig {
  pageWidthPx: number;
  pageHeightPx: number;
  mmToPx: number;
  dinZones: DinZone[];
  variableGroups: VariableGroup[];
  renderText: RenderText;
  legalRules: LegalRule[];
}
