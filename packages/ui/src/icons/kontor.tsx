import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/**
 * The shell's own icon set: 16px grid, stroke 1.5, default (butt) caps and
 * miter joins. Deliberately angular so the navigation reads like a ledger
 * sheet rather than a stock library. Typed as `LucideIcon`, so it drops into
 * every place that renders `<Icon size={16} />`. Lucide stays everywhere else.
 */
const kontorIcon = (displayName: string, paths: string[]): LucideIcon => {
  const Icon = React.forwardRef<SVGSVGElement, Omit<LucideProps, 'ref'>>(
    ({ size = 16, color = 'currentColor', strokeWidth = 1.5, absoluteStrokeWidth: _absolute, children, ...rest }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        aria-hidden="true"
        {...rest}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
        {children}
      </svg>
    ),
  );
  Icon.displayName = displayName;
  return Icon;
};

export const KontorIcon = {
  overview: kontorIcon('KontorOverview', ['M2 13V6.5L8 2l6 4.5V13H2Z', 'M6 13V9h4v4']),
  booking: kontorIcon('KontorBooking', ['M2 3h12', 'M8 3v10', 'M2 13h4', 'M10 13h4']),
  bank: kontorIcon('KontorBank', ['M2 6 8 2l6 4', 'M3 6v6M7 6v6M9 6v6M13 6v6', 'M2 14h12']),
  receipts: kontorIcon('KontorReceipts', ['M3.5 2h9v12l-2-1.2L8.5 14 6.5 12.8 4.5 14 3.5 13V2Z', 'M6 5.5h4M6 8h4']),
  documents: kontorIcon('KontorDocuments', ['M4 2h5l3 3v9H4V2Z', 'M9 2v3h3', 'M6 9h4M6 11.5h3']),
  clients: kontorIcon('KontorClients', ['M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M3 14c0-2.5 2.2-4 5-4s5 1.5 5 4']),
  articles: kontorIcon('KontorArticles', ['M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3v-5Z', 'M2.5 5.5 8 8.5l5.5-3M8 8.5v5']),
  openItems: kontorIcon('KontorOpenItems', ['M2 4h12v8H2z', 'M2 7h12', 'M5 10h3']),
  reports: kontorIcon('KontorReports', ['M2 14h12', 'M4 14V8M7.5 14V4M11 14v-4']),
  settings: kontorIcon('KontorSettings', [
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4 11.2 4.8M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4',
  ]),
  tax: kontorIcon('KontorTax', ['M8 2v12', 'M4 5h8', 'M2 11 4 5l2 6a2.2 2.2 0 0 1-4 0Z', 'M10 11l2-6 2 6a2.2 2.2 0 0 1-4 0Z']),
  exceptions: kontorIcon('KontorExceptions', ['M8 2 1.5 13.5h13L8 2Z', 'M8 6.5v3M8 11.5v.5']),
  // Drawn for this app in the same geometry; the prototype had no equivalent.
  recurring: kontorIcon('KontorRecurring', ['M2.5 7V4.5h10', 'm10.5 2.5 2 2-2 2', 'M13.5 9v2.5h-10', 'm5.5 13.5-2-2 2-2']),
  projects: kontorIcon('KontorProjects', ['M2 5h12v8H2z', 'M5.5 5V3h5v2', 'M2 9h12']),
  assets: kontorIcon('KontorAssets', ['M3 14V2h7v12', 'M10 6h3v8', 'M1.5 14h13', 'M5.5 5h2M5.5 8h2M5.5 11h2']),
  special: kontorIcon('KontorSpecial', ['M8 2 14 5 8 8 2 5 8 2Z', 'm2 8 6 3 6-3', 'm2 11 6 3 6-3']),
  // Drawn for this app: a balance moving over time (Geldkonten).
  money: kontorIcon('KontorMoney', ['M2 14h12', 'M2.5 10.5 6 7l2.5 2.5L13 5', 'M10.5 5H13v2.5']),
  accounts: kontorIcon('KontorAccounts', ['M2 4.5h12v9H2z', 'M3.5 4.5 11 2.5v2', 'M10.5 8h3.5v2.5h-3.5z']),
  templates: kontorIcon('KontorTemplates', ['M2 2h12v12H2z', 'M2 6h12', 'M7 6v8']),
  system: kontorIcon('KontorSystem', ['M2 3h12v8H2z', 'M8 11v3', 'M5 14h6']),
  // Shell chrome.
  search: kontorIcon('KontorSearch', ['M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Z', 'm10.6 10.6 3.4 3.4']),
  menu: kontorIcon('KontorMenu', ['M2 4h12M2 8h12M2 12h12']),
  panel: kontorIcon('KontorPanel', ['M2 3h12v10H2z', 'M6 3v10']),
  sun: kontorIcon('KontorSun', [
    'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    'M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1 1M4.1 11.9l-1 1M12.9 12.9l-1-1M4.1 4.1l-1-1',
  ]),
  moon: kontorIcon('KontorMoon', ['M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z']),
} satisfies Record<string, LucideIcon>;
