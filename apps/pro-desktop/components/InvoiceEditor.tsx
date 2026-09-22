import React from 'react';
import { InvoiceEditor as ShellInvoiceEditor, type InvoiceEditorProps } from '@billme/desktop-ui';

type Props = Omit<InvoiceEditorProps, 'product'>;

export const InvoiceEditor: React.FC<Props> = (props) => <ShellInvoiceEditor {...props} product="pro" />;
