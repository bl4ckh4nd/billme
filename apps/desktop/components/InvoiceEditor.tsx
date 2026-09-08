import React from 'react';
import { TemplateEditor, type TemplateEditorProps } from '@billme/desktop-renderer/components/TemplateEditor';

export const InvoiceEditor: React.FC<Omit<TemplateEditorProps, 'product'>> = (props) => (
  <TemplateEditor {...props} product="lite" />
);
