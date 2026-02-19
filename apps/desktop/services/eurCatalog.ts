import lines2025 from '../eur/lines-2025.json';

export type EurLineKind = 'income' | 'expense' | 'computed';

export type EurLineDef = {
  year: number;
  id: string;
  kennziffer: string;
  label: string;
  kind: EurLineKind;
  exportable: boolean;
  computedFromIds?: string[];
};

export const EUR_SOURCE_VERSION_2025 = 'BMF-2025-2025-08-29';

export const getCatalogForYear = (year: number): EurLineDef[] => {
  if (year === 2025) {
    const lines = lines2025 as EurLineDef[];
    validateEurLineCatalog(lines);
    return lines;
  }
  return [];
};

export const validateEurLineCatalog = (lines: EurLineDef[]): void => {
  const ids = new Set<string>();
  const kzs = new Set<string>();

  for (const line of lines) {
    if (ids.has(line.id)) {
      throw new Error(`Duplicate EÜR line id: ${line.id}`);
    }
    ids.add(line.id);

    const kz = line.kennziffer?.trim();
    if (kz) {
      const key = `${line.year}:${kz}`;
      if (kzs.has(key)) {
        throw new Error(`Duplicate EÜR Kennziffer in year ${line.year}: ${kz}`);
      }
      kzs.add(key);
    }
  }

  for (const line of lines) {
    if (line.kind !== 'computed') continue;
    for (const childId of line.computedFromIds ?? []) {
      if (!ids.has(childId)) {
        throw new Error(`Computed line ${line.id} references missing id: ${childId}`);
      }
    }
  }

  const byId = new Map(lines.map((line) => [line.id, line]));
  const visited = new Set<string>();
  const stack = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (stack.has(id)) {
      throw new Error(`Cycle detected in computed EÜR lines at: ${id}`);
    }
    stack.add(id);
    const line = byId.get(id);
    if (line?.kind === 'computed') {
      for (const child of line.computedFromIds ?? []) {
        visit(child);
      }
    }
    stack.delete(id);
    visited.add(id);
  };

  for (const line of lines) {
    visit(line.id);
  }
};
