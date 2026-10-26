import React from 'react';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '../utils/cn';

export interface TimeSeriesDatum {
  key: string;
  /** Axis label, e.g. "Jan 24". */
  label: string;
  /** Tooltip and table label, e.g. "Januar 2024". */
  longLabel?: string;
  /** One value per series key; a missing value counts as 0. */
  values: Readonly<Record<string, number>>;
}

export interface TimeSeriesSeries {
  key: string;
  label: string;
  kind: 'bar' | 'line';
  /** Bars: `solid` is the measure in focus, `hatched` the context beside or below it. */
  style?: 'solid' | 'hatched';
  /** Drawn below the zero line (e.g. Aufwand); tooltip and table still show the value as given. */
  downward?: boolean;
  /** Bars with the same stack share a column (an upward and a downward series form one diverging bar). */
  stack?: string;
}

export interface TimeSeriesChartProps {
  data: ReadonlyArray<TimeSeriesDatum>;
  series: ReadonlyArray<TimeSeriesSeries>;
  formatValue: (value: number) => string;
  /** Compact axis tick format; defaults to formatValue. */
  formatAxis?: (value: number) => string;
  /** Names the chart; also the caption of the screen-reader table. */
  'aria-label': string;
  /** The one focal period (e.g. the current or the selected month), drawn in the brand accent. */
  highlightKey?: string;
  /** Click on a period (and a button per row in the screen-reader table). */
  onSelect?: (key: string) => void;
  /** Names what onSelect opens, for the table buttons, e.g. "Buchungen anzeigen". */
  selectLabel?: string;
  height?: number;
  className?: string;
}

const AXIS_WIDTH = 60;
const COLOR = {
  solid: 'var(--color-foreground)',
  line: 'var(--color-foreground-secondary)',
  accent: 'var(--color-accent)',
  grid: 'var(--color-border)',
  zero: 'var(--color-foreground)',
  muted: 'var(--color-muted)',
  cursor: 'var(--color-surface-sunken)',
};

/**
 * Billme's chart for figures over time: bars and lines on one time axis, built on Recharts. Upward and downward
 * bars of one stack form a diverging column (Erträge up, Aufwand down), a line carries the balance. Colours,
 * tooltip and legend follow DESIGN.md (foreground bars, hatched context, lime only for the focal period); a visually
 * hidden table carries every value, with a button per period when the chart opens one. No animation, so print and
 * screenshots never catch a half-drawn chart.
 */
export const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
  data,
  series,
  formatValue,
  formatAxis = formatValue,
  'aria-label': ariaLabel,
  highlightKey,
  onSelect,
  selectLabel = 'Öffnen',
  height = 260,
  className,
}) => {
  const patternId = `tsc-hatch-${React.useId().replace(/:/g, '')}`;
  const rows = React.useMemo(() => data.map((datum) => ({
    key: datum.key,
    label: datum.label,
    longLabel: datum.longLabel ?? datum.label,
    ...Object.fromEntries(series.map((entry) => {
      const value = datum.values[entry.key] ?? 0;
      return [entry.key, entry.downward ? -value : value];
    })),
  })), [data, series]);
  const hasNegative = rows.some((row) => series.some((entry) => Number((row as Record<string, unknown>)[entry.key]) < 0));
  const hasHatched = series.some((entry) => entry.kind === 'bar' && entry.style === 'hatched');
  const showLegend = series.length > 1;

  const select = (index: unknown) => {
    const position = Number(index);
    const datum = Number.isInteger(position) ? data[position] : undefined;
    if (datum && onSelect) onSelect(datum.key);
  };

  /** What the tooltip reads of Recharts' content props; the rows carry the series values by key. */
  const renderTooltip = ({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; payload?: unknown }>; label?: unknown }) => {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload as { longLabel?: string } | undefined;
    return (
      <div className="flex flex-col gap-0.5 whitespace-nowrap rounded-control border border-border-toast bg-surface-toast px-2.75 py-2 text-caption text-inverse-foreground shadow-lift">
        <strong className="text-control font-semibold">{row?.longLabel ?? String(label ?? '')}</strong>
        {series.map((entry) => {
          const point = payload.find((item) => item.dataKey === entry.key);
          if (!point) return null;
          const value = Number(point.value ?? 0);
          return <span key={entry.key} className="tabular-nums text-ink-200">{entry.label} {formatValue(entry.downward ? -value : value)}</span>;
        })}
        {onSelect ? <span className="text-micro text-ink-200 opacity-80">Klicken: {selectLabel}</span> : null}
      </div>
    );
  };

  return (
    <figure className={cn('relative m-0', className)}>
      {hasHatched && (
        <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
          <defs>
            <pattern id={patternId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="var(--color-surface-sunken)" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--color-border-strong)" strokeWidth="3" />
            </pattern>
          </defs>
        </svg>
      )}
      <div style={{ height }} className={cn('w-full', onSelect && '[&_.recharts-surface]:cursor-pointer')} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            stackOffset="sign"
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            onClick={onSelect ? (state) => select(state?.activeTooltipIndex ?? state?.activeIndex) : undefined}
            accessibilityLayer={false}
          >
            <CartesianGrid vertical={false} stroke={COLOR.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={14} tick={{ fill: COLOR.muted, fontSize: 11 }} />
            <YAxis width={AXIS_WIDTH} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatAxis(value)} tick={{ fill: COLOR.muted, fontSize: 11 }} />
            {hasNegative && <ReferenceLine y={0} stroke={COLOR.zero} strokeWidth={1} />}
            <Tooltip cursor={{ fill: COLOR.cursor, opacity: 0.6 }} content={renderTooltip} isAnimationActive={false} />
            {series.map((entry) => entry.kind === 'bar' ? (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                name={entry.label}
                stackId={entry.stack}
                isAnimationActive={false}
                maxBarSize={28}
                radius={entry.downward ? [0, 0, 3, 3] : [3, 3, 0, 0]}
                fill={entry.style === 'hatched' ? `url(#${patternId})` : COLOR.solid}
              >
                {rows.map((row) => {
                  const focal = row.key === highlightKey && entry.style !== 'hatched';
                  return <Cell key={row.key} fill={focal ? COLOR.accent : entry.style === 'hatched' ? `url(#${patternId})` : COLOR.solid} stroke={focal ? COLOR.solid : undefined} strokeWidth={focal ? 1.5 : 0} />;
                })}
              </Bar>
            ) : (
              <Line
                key={entry.key}
                dataKey={entry.key}
                name={entry.label}
                type="linear"
                stroke={COLOR.line}
                strokeWidth={2}
                dot={rows.length <= 36 ? { r: 2, fill: COLOR.line, strokeWidth: 0 } : false}
                activeDot={{ r: 4, fill: COLOR.solid, strokeWidth: 0 }}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {showLegend && (
        <figcaption aria-hidden="true" className="mt-3 flex flex-wrap justify-center gap-3 text-caption text-foreground-secondary">
          {series.map((entry) => (
            <span key={entry.key} className="inline-flex items-center gap-1.5">
              {entry.kind === 'line' ? (
                <span className="h-0 w-3 border-t-2 border-foreground-secondary" />
              ) : entry.style === 'hatched' ? (
                <span className="size-2.25 rounded-xs bg-surface-sunken outline outline-1 outline-border-strong" />
              ) : (
                <span className="size-2.25 rounded-xs bg-foreground" />
              )}
              {entry.label}
            </span>
          ))}
        </figcaption>
      )}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Zeitraum</th>
            {series.map((entry) => <th key={entry.key} scope="col">{entry.label}</th>)}
            {onSelect ? <th scope="col">Aktion</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.key}>
              <th scope="row">{datum.longLabel ?? datum.label}</th>
              {series.map((entry) => <td key={entry.key}>{formatValue(datum.values[entry.key] ?? 0)}</td>)}
              {onSelect ? <td><button type="button" onClick={() => onSelect(datum.key)}>{selectLabel}: {datum.longLabel ?? datum.label}</button></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
