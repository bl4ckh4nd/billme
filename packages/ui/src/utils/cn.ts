import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/* The theme's type roles and radius aliases are custom utilities. Without
   registering them, tailwind-merge reads `text-label` as a text colour and
   drops it beside `text-foreground`, and cannot resolve `rounded-control`
   against `rounded-xl`. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['title', 'section', 'label', 'caption', 'figure'] }],
      rounded: [{ rounded: ['control', 'card', 'panel', 'modal'] }],
      shadow: [{ shadow: ['button', 'button-inverse'] }],
    },
  },
});

/**
 * Utility to merge Tailwind classes with proper conflict resolution
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
