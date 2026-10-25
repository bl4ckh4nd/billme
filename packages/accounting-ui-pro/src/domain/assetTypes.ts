export type AssetStatus = 'entwurf' | 'aktiv' | 'voll_abgeschrieben' | 'verkauft' | 'stillgelegt';
export type DepreciationMethod = 'linear' | 'degressive' | 'gwg' | 'pool';

export interface AssetItem {
  id: string;
  assetNumber: string;
  name: string;
  assetClass: string;
  status: AssetStatus;
  activationDate: string;
  acquisitionCost: number;
  residualValue: number;
  annualDepreciation: number;
  usefulLifeYears?: number;
  depreciationMethod: DepreciationMethod;
  costCenter: string;
  location: string;
  nextDepreciation: string;
  receiptLinked: boolean;
  supplier?: string;
  invoiceRef?: string;
  assetAccountNumber: string;
  /** Zugang über eine gebuchte Eingangsrechnung: Vorsteuer und Kreditor-OP stammen aus ihr, die Anlage bucht nichts nach. */
  sourceIncomingInvoiceId?: string;
  /** Zugang ohne Rechnung: das Gegenkonto der Aktivierung (z. B. Bank). */
  acquisitionOffsetAccountNumber?: string;
  disposalDate?: string;
  disposalProceeds?: number;
}

export type AssetUpsertInput = Omit<
  AssetItem,
  'id' | 'residualValue' | 'annualDepreciation' | 'nextDepreciation' | 'disposalDate' | 'disposalProceeds'
> & { id?: string };

export interface AssetRegisterAmounts {
  opening: number;
  additions: number;
  disposals: number;
  depreciation: number;
  closing: number;
}

/** Anlagenspiegel of a Wirtschaftsjahr (book values from the server). */
export interface AssetRegister {
  year: number;
  from: string;
  to: string;
  rows: Array<AssetRegisterAmounts & { assetId: string; assetNumber: string; name: string; accountNumber: string }>;
  totals: AssetRegisterAmounts;
}

export interface AssetDepreciationScheduleEntry {
  id: string;
  assetId: string;
  year: number;
  amount: number;
  months: number;
  status: 'planned' | 'posted' | 'cancelled';
  journalEntryId?: string;
  postedAt?: string;
}
