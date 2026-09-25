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
  const max = niceMax(Math.max(0, reference?.value ?? 0, ...data.map((datum) => Math.max(datum.value, datum.compare ?? 0))));
  const plotWidth = Math.max(0, width - AXIS_WIDTH);
  const plotHeight = height - X_LABEL_HEIGHT - TOP_PAD;
  const band = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = paired ? Math.max(2, Math.min(18, band * 0.32)) : Math.max(2, Math.min(32, band - 2, band * 0.62));
  const y = (value: number) => TOP_PAD + plotHeight - (Math.max(0, value) / max) * plotHeight;
  const hoveredDatum = hovered === null ? null : data[hovered];

  return (
    <figure className={cn('relative m-0', className)}>
      <div ref={containerRef} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
            {paired && (
              <defs>
                <pattern id={patternId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="5" height="5" className="fill-surface-sunken" />
                  <line x1="0" y1="0" x2="0" y2="5" className="stroke-control-border" strokeWidth="2" />
                </pattern>
              </defs>
            )}
            {Array.from({ length: TICKS + 1 }, (_, index) => {
              const value = (max / TICKS) * index;
              const tickY = y(value);
              return (
                <g key={index}>
                  <line x1={AXIS_WIDTH} x2={width} y1={tickY} y2={tickY} className={index === 0 ? 'stroke-control-border' : 'stroke-border'} strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={AXIS_WIDTH - 8} y={tickY} dy="0.32em" textAnchor="end" className="fill-muted text-caption tabular-nums">
                    {formatAxis(value)}
                  </text>
                </g>
              );
            })}
            {data.map((datum, index) => {
              const center = AXIS_WIDTH + band * index + band / 2;
              const top = y(datum.value);
              const barHeight = TOP_PAD + plotHeight - top;
              const active = hovered === index;
              const primaryX = paired ? center - barWidth - 1 : center - barWidth / 2;
              const compareTop = y(datum.compare ?? 0);
              const compareHeight = TOP_PAD + plotHeight - compareTop;
              return (
                <g key={datum.key}>
                  {paired && compareHeight > 0 && (
                    <path
                      d={barPath(center + 1, compareTop, barWidth, compareHeight)}
                      fill={`url(#${patternId})`}
                      className="stroke-control-border"
                      strokeWidth={1}
                    />
                  )}
                  {barHeight > 0 && (
                    <path
                      d={barPath(primaryX, top, barWidth, barHeight)}
                      className={cn(
                        'transition-[fill] duration-(--dur-micro) motion-reduce:transition-none',
                        datum.highlight ? 'fill-accent stroke-foreground' : active ? 'fill-foreground' : paired ? 'fill-ink-600' : 'fill-ink-400',
                      )}
                      strokeWidth={datum.highlight ? 1 : 0}
                    />
                  )}
                  <text
                    x={center}
                    y={height - 6}
                    textAnchor="middle"
                    className={cn('text-caption', datum.highlight || active ? 'fill-foreground font-medium' : 'fill-muted')}
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
                <line x1={AXIS_WIDTH} x2={width} y1={y(reference.value)} y2={y(reference.value)} className="stroke-foreground" strokeWidth={1} strokeDasharray="4 4" />
                {/* Left end: the right end is where the current, highlighted period sits. */}
                <text x={AXIS_WIDTH + 4} y={y(reference.value) - 5} textAnchor="start" className="fill-foreground text-caption font-medium">
                  {reference.label}
                </text>
              </g>
            )}
          </svg>
        )}
        {hoveredDatum && hovered !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm bg-surface-inverse px-2 py-1 text-caption text-inverse-foreground"
            style={{ left: AXIS_WIDTH + band * hovered + band / 2, top: y(hoveredDatum.value) - 6 }}
          >
            <span className="text-inverse-muted">{hoveredDatum.longLabel ?? hoveredDatum.label}</span>{' '}
            <span className="font-medium tabular-nums">{formatValue(hoveredDatum.value)}</span>
            {paired && hoveredDatum.compare !== undefined && (
              <>
                {' · '}
                <span className="text-inverse-muted">{compareHeader}</span>{' '}
                <span className="font-medium tabular-nums">{formatValue(hoveredDatum.compare)}</span>
              </>
            )}
          </div>
        )}
      </div>
      {paired && (
        <figcaption aria-hidden="true" className="mt-2 flex flex-wrap gap-3 text-caption text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-xs bg-ink-600" />{valueHeader}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-xs border border-control-border bg-[repeating-linear-gradient(135deg,var(--color-surface-sunken)_0_2px,var(--color-control-border)_2px_3px)]" />
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
