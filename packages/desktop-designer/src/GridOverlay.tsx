import React from 'react';

export interface GridOverlayProps {
  enabled: boolean;
  size: number; // px
  width: number;
  height: number;
}

/** Subtle, non-interactive grid drawn over the page when enabled. */
export const GridOverlay: React.FC<GridOverlayProps> = ({ enabled, size, width, height }) => {
  if (!enabled || size <= 0) return null;
  // Derived from the foreground token so the guide keeps its weight if the ink colour moves.
  const line = 'color-mix(in srgb, var(--color-foreground) 6%, transparent)';
  return (
    <div
      aria-hidden
      className="absolute top-0 left-0 pointer-events-none no-print"
      style={{
        width: `${width}px`,
        height: `${height}px`,
        backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
        backgroundSize: `${size}px ${size}px`,
      }}
    />
  );
};
