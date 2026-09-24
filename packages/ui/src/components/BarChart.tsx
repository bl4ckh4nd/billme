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
}

export interface BarChartProps {
  data: ReadonlyArray<BarDatum>;
  formatValue: (value: number) => string;
  /** Compact axis tick format; defaults to formatValue. */
  formatAxis?: (value: number) => string;
  /** Names the chart; also the caption of the screen-reader table. */
  'aria-label': string;
  valueHeader?: string;
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
 * Single-series bar chart for one measure over time. No legend: the title
 * names the series. Hover or focus shows the value; a visually hidden table
 * carries every value for assistive tech.
 */
export const BarChart: React.FC<BarChartProps> = ({
  data,
  formatValue,
  formatAxis = formatValue,
  'aria-label': ariaLabel,
  valueHeader = 'Wert',
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

  const max = niceMax(Math.max(0, ...data.map((datum) => datum.value)));
  const plotWidth = Math.max(0, width - AXIS_WIDTH);
  const plotHeight = height - X_LABEL_HEIGHT - TOP_PAD;
  const band = data.length > 0 ? plotWidth / data.length : 0;
  const barWidth = Math.max(2, Math.min(32, band - 2, band * 0.62));
  const y = (value: number) => TOP_PAD + plotHeight - (Math.max(0, value) / max) * plotHeight;
  const hoveredDatum = hovered === null ? null : data[hovered];

  return (
    <figure className={cn('relative m-0', className)}>
      <div ref={containerRef} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
            {Array.from({ length: TICKS + 1 }, (_, index) => {
              const value = (max / TICKS) * index;
              const tickY = y(value);
              return (
                <g key={index}>
                  <line x1={AXIS_WIDTH} x2={width} y1={tickY} y2={tickY} className={index === 0 ? 'stroke-ink-300' : 'stroke-ink-100'} strokeWidth={1} shapeRendering="crispEdges" />
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
              return (
                <g key={datum.key}>
                  {barHeight > 0 && (
                    <path
                      d={barPath(center - barWidth / 2, top, barWidth, barHeight)}
                      className={cn(
                        'transition-[fill] duration-(--dur-micro) motion-reduce:transition-none',
                        datum.highlight ? 'fill-accent stroke-ink-950' : active ? 'fill-ink-600' : 'fill-ink-400',
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
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Zeitraum</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.key}>
              <th scope="row">{datum.longLabel ?? datum.label}</th>
              <td>{formatValue(datum.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
