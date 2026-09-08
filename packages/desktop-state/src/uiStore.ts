import { create } from 'zustand';

export interface BaseUiState<TInvoice> {
  editingInvoice: TInvoice | null;
  editingDocumentType: 'invoice' | 'offer' | null;
  editingDocumentMode: 'create' | 'edit' | null;
  setEditingInvoice: (invoice: TInvoice, type: 'invoice' | 'offer', mode?: 'create' | 'edit') => void;
  clearEditingInvoice: () => void;
}

export const createUiStore = <TInvoice>() =>
  create<BaseUiState<TInvoice>>((set) => ({
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
