import type { DinZone } from '../types';

export interface Guidelines {
  vertical: number[]; // x positions (page px)
  horizontal: number[]; // y positions (page px)
}

const uniqueRounded = (values: number[]): number[] =>
  Array.from(new Set(values.map((n) => Math.round(n)))).sort((a, b) => a - b);

/**
 * Static snap guidelines for the page: edges, centers, the standard 20mm
 * margins, and the DIN 5008 zone boundaries. Element-to-element snapping is
 * handled separately by Moveable's `elementGuidelines`.
 */
export function buildGuidelines(pageW: number, pageH: number, mmToPx: number, dinZones: DinZone[]): Guidelines {
  const margin = 20 * mmToPx;
  return {
    vertical: uniqueRounded([
      0,
      pageW / 2,
      pageW,
      margin,
      pageW - margin,
      ...dinZones.map((z) => z.x),
      ...dinZones.map((z) => z.x + z.width),
    ]),
    horizontal: uniqueRounded([
      0,
      pageH / 2,
      pageH,
      ...dinZones.map((z) => z.y),
      ...dinZones.map((z) => z.y + z.height),
    ]),
  };
}
