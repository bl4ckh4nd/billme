import React from 'react';
import { cn } from '../utils/cn';

export interface BarDatum {
  key: string;
  /** Axis label, e.g. "Jan". */
  label: string;
  /** Full label for the tooltip and the table view, e.g. "Januar 2026". */
  longLabel?: string;
  value: number;
  /** The one focal bar (e.g. the current period), drawn in the brand accent. */
  highlight?: boolean;
  /** Optional second measure for the same period (e.g. expenses), drawn hatched beside the bar. */
  compare?: number;
}

export interface BarChartProps {
  data: ReadonlyArray<BarDatum>;
  formatValue: (value: number) => string;
  /** Compact axis tick format; defaults to formatValue. */
  formatAxis?: (value: number) => string;
  /** Names the chart; also the caption of the screen-reader table. */
  'aria-label': string;
  valueHeader?: string;
  /** Names the hatched comparison series; shown in the legend and the table. */
  compareHeader?: string;
  /** Dashed reference line, e.g. a twelve-month average or a target. */
  reference?: { value: number; label: string };
  height?: number;
  className?: string;
}

const AXIS_WIDTH = 56;
const X_LABEL_HEIGHT = 24;
const TOP_PAD = 8;
const TICKS = 4;

/** Rounds the max up to 1, 2, 2.5 or 5 times a power of ten, so ticks read cleanly. */
export const niceMax = (value: number): number => {
  if (value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * exponent >= value) ?? 10;
  return step * exponent;
};

/** Top-rounded bar anchored to the baseline (4px radius, clamped to the bar size). */
const barPath = (x: number, y: number, width: number, height: number): string => {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
};

/**
 * Bar chart for one measure over time, optionally paired with a hatched
 * comparison series (context against focus) and a dashed reference line. A
 * single series gets no legend: the title names it. Hover or focus shows the value; a visually hidden table
 * carries every value for assistive tech.
 */
export const BarChart: React.FC<BarChartProps> = ({
  data,
  formatValue,
  formatAxis = formatValue,
  'aria-label': ariaLabel,
  valueHeader = 'Wert',
  compareHeader,
  reference,
  height = 240,
  className,
}) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [hovered, setHovered] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const paired = data.some((datum) => datum.compare !== undefined);
  const patternId = React.useId().replace(/:/g, '');
  const top = Math.max(0, reference?.value ?? 0, ...data.map((datum) => Math.max(datum.value, datum.compare ?? 0)));
  // Negative values (a month with refunds) draw below a zero line; without any the scale starts at 0 as before.
  const negative = Math.max(0, ...data.map((datum) => -datum.value));
  // With negatives the ticks are whole multiples of one round step (0, ±500, ±1.000), never a split of an odd range.
  const step = negative > 0 ? niceMax((top + negative) / TICKS) : 0;
  const max = negative > 0 ? Math.max(step, Math.ceil(top / step) * step) : niceMax(top);
  const min = negative > 0 ? -Math.ceil(negative / step) * step : 0;
  const tickCount = negative > 0 ? Math.round((max - min) / step) : TICKS;
  const plotWidth = Math.max(0, width - AXIS_WIDTH);
  const plotHeight = height - X_LABEL_HEIGHT - TOP_PAD;
  const band = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = paired ? Math.max(2, Math.min(18, band * 0.32)) : Math.max(2, Math.min(32, band - 2, band * 0.62));
  const y = (value: number) => TOP_PAD + plotHeight - ((Math.max(min, value) - min) / (max - min)) * plotHeight;
  const zeroY = y(0);
  const hoveredDatum = hovered === null ? null : data[hovered];

  return (
    <figure className={cn('relative m-0', className)}>
      <div ref={containerRef} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
            {paired && (
              <defs>
                <pattern id={patternId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="7" height="7" className="fill-surface-sunken" />
                  <line x1="0" y1="0" x2="0" y2="7" className="stroke-border-strong" strokeWidth="3" />
                </pattern>
              </defs>
            )}
            {Array.from({ length: tickCount + 1 }, (_, index) => {
              const value = min + ((max - min) / tickCount) * index;
              const tickY = y(value);
              return (
                <g key={index}>
                  <line x1={AXIS_WIDTH} x2={width} y1={tickY} y2={tickY} className="stroke-border" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={AXIS_WIDTH - 8} y={tickY} dy="0.32em" textAnchor="end" className="fill-muted text-micro tabular-nums">
                    {formatAxis(value)}
                  </text>
                </g>
              );
            })}
            {min < 0 && <line x1={AXIS_WIDTH} x2={width} y1={zeroY} y2={zeroY} className="stroke-foreground" strokeWidth={1} shapeRendering="crispEdges" />}
            {data.map((datum, index) => {
              const center = AXIS_WIDTH + band * index + band / 2;
              const top = y(datum.value);
              const barHeight = zeroY - top;
              const active = hovered === index;
              const primaryX = paired ? center - barWidth - 1 : center - barWidth / 2;
              const compareTop = y(datum.compare ?? 0);
              const compareHeight = zeroY - compareTop;
              return (
                <g key={datum.key}>
                  {paired && compareHeight > 0 && (
                    <path
                      d={barPath(center + 1, compareTop, barWidth, compareHeight)}
                      fill={`url(#${patternId})`}
                    />
                  )}
                  {datum.value < 0 && (
                    <path d={`M${primaryX},${zeroY}H${primaryX + barWidth}V${top}H${primaryX}Z`} className="fill-foreground" />
                  )}
                  {barHeight > 0 && (
                    <path
                      d={barPath(primaryX, top, barWidth, barHeight)}
                      className={datum.highlight ? 'fill-accent stroke-foreground' : 'fill-foreground'}
                      strokeWidth={datum.highlight ? 1.5 : 0}
                    />
                  )}
                  <text
                    x={center}
                    y={height - 6}
                    textAnchor="middle"
                    className={cn('text-micro', datum.highlight || active ? 'fill-foreground font-semibold' : 'fill-muted')}
                  >
                    {datum.label}
                  </text>
                  {/* Hit target: the whole band, taller than the mark. */}
                  <rect
                    x={AXIS_WIDTH + band * index}
                    y={TOP_PAD}
                    width={band}
                    height={plotHeight}
                    fill="transparent"
                    onPointerEnter={() => setHovered(index)}
                    onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
                  />
                </g>
              );
            })}
            {reference && reference.value > 0 && (
              <g aria-hidden="true">
                <line x1={AXIS_WIDTH} x2={width} y1={y(reference.value)} y2={y(reference.value)} className="stroke-foreground opacity-50" strokeWidth={1.5} strokeDasharray="5 4" />
                {/* Left end: the right end is where the current, highlighted period sits. */}
                <text x={AXIS_WIDTH + 4} y={y(reference.value) - 5} textAnchor="start" className="fill-muted text-micro tabular-nums">
                  {reference.label}
                </text>
              </g>
            )}
          </svg>
        )}
        {hoveredDatum && hovered !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-full flex-col gap-0.5 whitespace-nowrap rounded-control border border-border-toast bg-surface-toast px-2.75 py-2 text-caption text-inverse-foreground shadow-lift"
            style={{ left: AXIS_WIDTH + band * hovered + band / 2, top: y(Math.max(hoveredDatum.value, hoveredDatum.compare ?? 0)) - 12 }}
          >
            <strong className="text-control font-semibold">{hoveredDatum.longLabel ?? hoveredDatum.label}</strong>
            <span className="tabular-nums text-ink-200">{paired ? `${valueHeader} ` : ''}{formatValue(hoveredDatum.value)}</span>
            {paired && hoveredDatum.compare !== undefined && (
              <span className="tabular-nums text-ink-200">{compareHeader} {formatValue(hoveredDatum.compare)}</span>
            )}
          </div>
        )}
      </div>
      {paired && (
        <figcaption aria-hidden="true" className="mt-3 flex flex-wrap justify-center gap-3 text-caption text-foreground-secondary">
          <span className="inline-flex items-center gap-1.5"><span className="size-2.25 rounded-xs bg-foreground" />{valueHeader}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.25 rounded-xs bg-surface-sunken outline outline-1 outline-border-strong" />
            {compareHeader}
          </span>
          {reference && reference.value > 0 && (
            <span className="inline-flex items-center gap-1.5"><span className="h-0 w-3 border-t border-dashed border-foreground" />{reference.label}</span>
          )}
        </figcaption>
      )}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Zeitraum</th>
            <th scope="col">{valueHeader}</th>
            {paired && <th scope="col">{compareHeader}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.key}>
              <th scope="row">{datum.longLabel ?? datum.label}</th>
              <td>{formatValue(datum.value)}</td>
              {paired && <td>{formatValue(datum.compare ?? 0)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
