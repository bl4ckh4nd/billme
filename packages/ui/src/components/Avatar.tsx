import React from 'react';
import { cn } from '../utils/cn';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** Full name; the avatar shows up to two initials and hides itself from assistive tech. */
  name: string;
  size?: AvatarSize;
  className?: string;
}

const sizeStyles: Record<AvatarSize, string> = {
  sm: 'size-7 text-xs',
  md: 'size-9 text-xs',
  lg: 'size-10 text-sm',
};

export const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0]!.slice(0, 2) : `${words[0]![0]}${words[words.length - 1]![0]}`;
  return letters.toUpperCase();
};

export const Avatar: React.FC<AvatarProps> = ({ name, size = 'md', className }) => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-flex shrink-0 select-none items-center justify-center rounded-full bg-surface-sunken font-semibold text-ink-700 shadow-[inset_0_0_0_1px_rgb(13_14_17/0.06)]',
      sizeStyles[size],
      className,
    )}
  >
    {initialsOf(name)}
  </span>
);
