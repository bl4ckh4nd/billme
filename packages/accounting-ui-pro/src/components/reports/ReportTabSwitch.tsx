import { REPORT_TABS, ReportTabId } from '../../domain/reportTypes';

interface ReportTabSwitchProps {
  activeTab: ReportTabId;
  onChange: (tab: ReportTabId) => void;
  tabs?: ReportTabId[];
}

export default function ReportTabSwitch({ activeTab, onChange, tabs }: ReportTabSwitchProps) {
  const visibleTabs = REPORT_TABS.filter((tab) => !tabs || tabs.includes(tab.id));
  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          title={tab.description}
          aria-pressed={activeTab === tab.id}
          onClick={() => onChange(tab.id)}
          className={`h-7 px-3 rounded-full text-xs font-bold border ${
            activeTab === tab.id ? 'bg-dark-base text-background border-dark-base' : 'bg-surface text-muted border-border hover:bg-surface-muted'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
