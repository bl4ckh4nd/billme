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
  const line = 'rgba(15, 23, 42, 0.06)';
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
