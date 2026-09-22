import React from 'react';
import { TemplateEditor, type TemplateEditorProps } from '@billme/desktop-renderer/components/TemplateEditor';

export interface InvoiceEditorProps extends Omit<TemplateEditorProps, 'product'> {
  /** Lite edits the lite template set, Pro the pro one. */
  product: 'lite' | 'pro';
}

export const InvoiceEditor: React.FC<InvoiceEditorProps> = ({ product, ...props }) => (
  <TemplateEditor {...props} product={product} />
);
