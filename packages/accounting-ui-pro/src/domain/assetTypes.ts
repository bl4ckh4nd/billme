export type AssetStatus = 'entwurf' | 'aktiv' | 'voll_abgeschrieben' | 'verkauft' | 'stillgelegt';
export type DepreciationMethod = 'linear' | 'gwg' | 'pool';

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
  disposalDate?: string;
  disposalProceeds?: number;
}

export type AssetUpsertInput = Omit<
  AssetItem,
  'id' | 'residualValue' | 'annualDepreciation' | 'nextDepreciation' | 'disposalDate' | 'disposalProceeds'
> & { id?: string };

export interface AssetDepreciationScheduleEntry {
  id: string;
  assetId: string;
  year: number;
  amount: number;
  months: number;
  status: 'planned' | 'posted';
  journalEntryId?: string;
  postedAt?: string;
}
