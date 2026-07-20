import React from 'react';
import { ipc } from '../../ipc/client';

interface SystemTabProps {
  backupPath: string;
  setBackupPath: (v: string) => void;
}

export const SystemTab: React.FC<SystemTabProps> = ({ backupPath, setBackupPath }) => {
  return (
    <div className="max-w-2xl space-y-10 animate-enter">
      <div>
        <h3 className="text-xl font-bold mb-1">System</h3>
        <p className="text-muted text-sm">Audit-Log, Backup und Wiederherstellung.</p>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h4 className="text-lg font-bold text-foreground">Audit</h4>
          <p className="text-sm text-muted">Audit-Log prüfen und als CSV exportieren.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={async () => {
              try {
                const result = await ipc.audit.verify();
                alert(JSON.stringify(result, null, 2));
              } catch (e) {
                alert(`Audit-Prüfung fehlgeschlagen: ${String(e)}`);
              }
            }}
            className="px-5 py-3 rounded-xl font-bold bg-surface border border-border hover:bg-surface-muted transition-colors duration-150 ease-out"
          >
            Verify
          </button>
          <button
            onClick={async () => {
              try {
                const csv = await ipc.audit.exportCsv();
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch (e) {
                alert(`CSV-Export fehlgeschlagen: ${String(e)}`);
              }
            }}
            className="px-5 py-3 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-150 ease-out"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="bg-surface-muted rounded-xl p-6 border border-border-subtle space-y-4">
        <div>
          <h4 className="text-lg font-bold text-foreground">Backup</h4>
          <p className="text-sm text-muted">
            Datenbank sichern oder aus einer Sicherung wiederherstellen.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={async () => {
              try {
                const res = await ipc.db.backup();
                alert(`Backup erstellt:\n${res.path}`);
              } catch (e) {
                alert(`Backup fehlgeschlagen: ${String(e)}`);
              }
            }}
            className="px-5 py-3 rounded-xl font-bold bg-surface border border-border hover:bg-surface-muted transition-colors duration-150 ease-out"
          >
            Backup erstellen
          </button>

          <div className="flex-1 flex gap-2">
            <input
              value={backupPath}
              onChange={(e) => setBackupPath(e.target.value)}
              placeholder="Pfad zur .sqlite Sicherung..."
              className="flex-1 bg-surface border border-border rounded-lg p-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
            />
            <button
              onClick={async () => {
                try {
                  const res = await ipc.db.restore({ path: backupPath.trim() });
                  alert(`Restore abgeschlossen:\n${JSON.stringify(res, null, 2)}`);
                } catch (e) {
                  alert(`Restore fehlgeschlagen: ${String(e)}`);
                }
              }}
              className="px-5 py-3 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-150 ease-out"
            >
              Restore
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
