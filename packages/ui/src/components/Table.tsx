import React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../utils/cn';

export type TableDensity = 'compact' | 'regular';
export type SortDirection = 'asc' | 'desc';

const DensityContext = React.createContext<TableDensity>('regular');

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  density?: TableDensity;
  /** Classes for the scroll container (height limits, margins). */
  containerClassName?: string;
  /** Drop the raised container when the table already sits inside a card. */
  bare?: boolean;
}

/**
 * Data table. Numbers right-align with tabular numerals (`numeric` cells),
 * the header sticks while the body scrolls, rows can be interactive and
 * selected. Column headers are the one place uppercase tracking is allowed.
 */
export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ density = 'regular', containerClassName, bare = false, className, children, ...props }, ref) => (
    <DensityContext.Provider value={density}>
      <div className={cn('relative w-full overflow-auto', !bare && 'rounded-card bg-surface shadow-xs', containerClassName)}>
        <table ref={ref} className={cn('w-full border-separate border-spacing-0 text-sm', className)} {...props}>
          {children}
        </table>
      </div>
    </DensityContext.Provider>
  ),
);
Table.displayName = 'Table';

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className, ...props }) => (
  <thead className={cn('sticky top-0 z-10', className)} {...props} />
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = (props) => <tbody {...props} />;

export const TableFooter: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className, ...props }) => (
  <tfoot className={cn('font-semibold [&_td]:border-t [&_td]:border-border [&_td]:bg-surface-muted', className)} {...props} />
);

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  /** Makes the whole row activate `onClick` by mouse, Enter and Space. */
  interactive?: boolean;
}

export const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ selected = false, interactive = false, className, onKeyDown, onClick, ...props }, ref) => (
    <tr
      ref={ref}
      aria-selected={selected || undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !interactive || event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      className={cn(
        'group group/row transition-colors motion-reduce:transition-none',
        interactive && 'cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring',
        selected && 'bg-accent-50 hover:bg-accent-50 [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-ink-950)]',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  /** Current sort state of this column; omit for unsortable columns. */
  sort?: SortDirection | false;
  onSort?: () => void;
}

export const TableHead: React.FC<TableHeadProps> = ({ numeric = false, sort, onSort, className, children, ...props }) => {
  const density = React.useContext(DensityContext);
  const sortable = onSort !== undefined;
  const SortIcon = sort === 'asc' ? ArrowUp : sort === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={sortable ? (sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none') : undefined}
      className={cn(
        'whitespace-nowrap border-b border-border bg-surface-muted px-3 text-caption font-medium uppercase tracking-[0.04em] text-muted',
        density === 'compact' ? 'h-8' : 'h-9',
        numeric ? 'text-right' : 'text-left',
        'first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            'inline-flex items-center gap-1 rounded-xs uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
            numeric && 'flex-row-reverse',
            sort && 'text-foreground',
          )}
        >
          {children}
          <SortIcon size={12} aria-hidden="true" className={cn(!sort && 'opacity-50')} />
        </button>
      ) : children}
    </th>
  );
};

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  /** Secondary cells: metadata such as dates and ids. */
  muted?: boolean;
}

export const TableCell: React.FC<TableCellProps> = ({ numeric = false, muted = false, className, ...props }) => {
  const density = React.useContext(DensityContext);
  return (
    <td
      className={cn(
        'border-b border-border-subtle px-3 align-middle group-last/row:border-b-0',
        density === 'compact' ? 'h-9' : 'h-11',
        numeric && 'text-right tabular-nums',
        muted ? 'text-muted' : 'text-foreground',
        'first:pl-4 last:pr-4',
        className,
      )}
      {...props}
    />
  );
};

/** Sort helper for local lists: flips direction on the same key, starts ascending on a new key. */
export function nextSort<K extends string>(
  current: { key: K; direction: SortDirection } | null,
  key: K,
): { key: K; direction: SortDirection } {
  if (current?.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: 'asc' };
}
