interface ReportTabSwitchProps {
  activeTab: 'susa' | 'guv' | 'bilanz';
  onChange: (tab: 'susa' | 'guv' | 'bilanz') => void;
}

const tabs: Array<{ id: 'susa' | 'guv' | 'bilanz'; label: string }> = [
  { id: 'susa', label: 'SuSa' },
  { id: 'guv', label: 'GuV' },
  { id: 'bilanz', label: 'Bilanz (Preview)' },
];

export default function ReportTabSwitch({ activeTab, onChange }: ReportTabSwitchProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`h-7 px-3 rounded-full text-xs font-bold border ${
            activeTab === tab.id ? 'bg-foreground text-white border-foreground' : 'bg-surface text-muted border-border hover:bg-surface-muted'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

