import { REPORT_TABS, ReportTabId } from '../../domain/reportTypes';

interface ReportTabSwitchProps {
  activeTab: ReportTabId;
  onChange: (tab: ReportTabId) => void;
  tabs?: ReportTabId[];
}

export default function ReportTabSwitch({ activeTab, onChange, tabs }: ReportTabSwitchProps) {
  const visibleTabs = REPORT_TABS.filter((tab) => !tabs || tabs.includes(tab.id));
  return (
    <div role="group" aria-label="Bericht" className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-border bg-surface-sunken p-0.5">
      {visibleTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          title={tab.description}
          aria-pressed={activeTab === tab.id}
          onClick={() => onChange(tab.id)}
          className={`inline-flex h-6.5 items-center whitespace-nowrap rounded-sm px-2.5 text-caption transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${
            activeTab === tab.id ? 'bg-surface font-semibold text-foreground shadow-thumb' : 'font-medium text-muted hover:text-foreground'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
