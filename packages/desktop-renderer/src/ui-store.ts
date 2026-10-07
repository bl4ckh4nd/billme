import { create } from 'zustand';
import type { Invoice, Offer } from '@billme/desktop-core/types';

export interface UiState {
  editingInvoice: Invoice | Offer | null;
  editingDocumentType: 'invoice' | 'offer' | null;
  editingDocumentMode: 'create' | 'edit' | null;
  setEditingInvoice: (invoice: Invoice | Offer, type: 'invoice' | 'offer', mode?: 'create' | 'edit') => void;
  clearEditingInvoice: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  editingInvoice: null,
  editingDocumentType: null,
  editingDocumentMode: null,
  setEditingInvoice: (invoice, type, mode = 'edit') =>
    set({ editingInvoice: invoice, editingDocumentType: type, editingDocumentMode: mode }),
  clearEditingInvoice: () =>
    set({
      editingInvoice: null,
      editingDocumentType: null,
      editingDocumentMode: null,
    }),
}));
