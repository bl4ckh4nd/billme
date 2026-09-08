export type EurListFilterSourceType = 'transaction' | 'invoice';
export type EurListFilterFlowType = 'income' | 'expense';
export type EurListFilterStatus = 'all' | 'unclassified' | 'classified' | 'excluded';
export type EurListFilterFactKind = 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through';

export type EurListFilterItem = {
  sourceType: EurListFilterSourceType;
  sourceId: string;
  date: string;
  amountGross: number;
  flowType: EurListFilterFlowType;
  accountId?: string;
  counterparty: string;
  purpose: string;
  kind?: EurListFilterFactKind;
  splits?: readonly unknown[];
  classification?: {
    eurLineId?: string;
    excluded?: boolean;
  };
};

export type EurListFilterParams = {
  onlyUnclassified?: boolean;
  sourceType?: EurListFilterSourceType;
  flowType?: EurListFilterFlowType;
  status?: EurListFilterStatus;
  search?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
};

const isFactClassified = (item: EurListFilterItem): boolean => Boolean(item.kind || item.splits?.length);

const isUnclassified = (item: EurListFilterItem): boolean =>
  !item.classification?.eurLineId && !item.classification?.excluded && !isFactClassified(item);

/**
 * Applies the canonical EÜR list semantics shared by hosted and embedded
 * server callers. The source list is ordered like the desktop report before
 * filtering, then status/search filters are applied, and only then is the
 * requested page sliced.
 */
export const filterEurListItems = <T extends EurListFilterItem>(
  sourceItems: readonly T[],
  params: EurListFilterParams,
): T[] => {
  let items = [...sourceItems].sort((left, right) =>
    left.date === right.date
      ? left.sourceId.localeCompare(right.sourceId)
      : left.date > right.date ? -1 : 1,
  );

  if (params.sourceType) items = items.filter((item) => item.sourceType === params.sourceType);
  if (params.flowType) items = items.filter((item) => item.flowType === params.flowType);
  if (params.accountId) items = items.filter((item) => item.accountId === params.accountId);

  const status = params.onlyUnclassified ? 'unclassified' : params.status;
  if (status && status !== 'all') {
    items = items.filter((item) => {
      if (status === 'unclassified') return isUnclassified(item);
      if (status === 'classified') return (Boolean(item.classification?.eurLineId) || isFactClassified(item)) && !item.classification?.excluded;
      return Boolean(item.classification?.excluded);
    });
  }

  if (params.search && params.search.trim().length > 0) {
    const needle = params.search.trim().toLowerCase();
    items = items.filter((item) =>
      item.counterparty.toLowerCase().includes(needle)
      || item.purpose.toLowerCase().includes(needle)
      || item.date.includes(needle)
      || String(item.amountGross).includes(needle),
    );
  }

  const offset = Math.max(0, params.offset ?? 0);
  if (params.limit && params.limit > 0) {
    items = items.slice(offset, offset + params.limit);
  } else if (offset > 0) {
    items = items.slice(offset);
  }

  return params.onlyUnclassified ? items.filter(isUnclassified) : items;
};
