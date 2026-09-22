import React from 'react';
import { ArrowDownToLine, LogOut, Minus, RefreshCw, Square, X } from 'lucide-react';
import { ipc } from '../ipc/client';
import billmeMarkLogo from '../assets/billme-mark.svg';
import { getBillmeRuntimeConfig } from '../runtime';

export const Titlebar: React.FC = () => {
  const runtime = React.useMemo(() => getBillmeRuntimeConfig(), []);
  const isWebShell = runtime.shell === 'web';
  const [isMaximized, setIsMaximized] = React.useState(false);
  const [updateStatus, setUpdateStatus] = React.useState<{
    status: string;
    version?: string;
    progress?: number;
  }>({ status: 'idle' });

  const syncWindowState = React.useCallback(async () => {
    try {
      const state = await ipc.window.isMaximized();
      setIsMaximized(state.isMaximized);
    } catch {
      // Ignore state sync errors in non-Electron fallback environments.
    }
  }, []);

  React.useEffect(() => {
    if (isWebShell) {
      return undefined;
    }

    void syncWindowState();

    window.billmeWindow?.onMaximizeChanged((state) => {
      setIsMaximized(Boolean(state?.isMaximized));
    });

    return () => {
      window.billmeWindow?.offMaximizeChanged?.();
    };
  }, [isWebShell, syncWindowState]);

  React.useEffect(() => {
    if (isWebShell) {
      return undefined;
    }

    ipc.updater.getStatus().then(setUpdateStatus).catch(() => {});

    window.billmeWindow?.onUpdateStatusChanged((payload) => {
      setUpdateStatus(payload);
    });

    return () => {
      window.billmeWindow?.offUpdateStatusChanged?.();
    };
  }, [isWebShell]);

  const minimize = () => {
    void ipc.window.minimize();
  };

  const toggleMaximize = () => {
    void ipc.window.toggleMaximize();
  };

  const close = () => {
    void ipc.window.close();
  };

  const handleUpdateClick = () => {
    if (updateStatus.status === 'available') {
      void ipc.updater.downloadUpdate();
    } else if (updateStatus.status === 'downloaded') {
      void ipc.updater.quitAndInstall();
    }
  };

  const showUpdateButton =
    updateStatus.status === 'available' ||
    updateStatus.status === 'downloading' ||
    updateStatus.status === 'downloaded';

  const handleLogout = () => {
    runtime.onLogout?.();
  };

  return (
    <div
      className="drag-region h-10 shrink-0 border-b border-border bg-surface flex items-center justify-between pl-3 pr-1 select-none no-print"
      onDoubleClick={toggleMaximize}
    >
      <div className="flex items-center gap-2 min-w-0">
        <img
          src={billmeMarkLogo}
          alt="Billme"
          className="w-5 h-5 object-contain"
          draggable={false}
        />
        <span className="text-xs font-bold tracking-wide text-foreground truncate">Billme</span>
      </div>

      <div className="no-drag flex items-center" onDoubleClick={(e) => e.stopPropagation()}>
        {isWebShell ? (
          runtime.onLogout ? (
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <LogOut size={14} aria-hidden="true" />
              Abmelden
            </button>
          ) : null
        ) : (
          <>
            {showUpdateButton && (
              <button
                type="button"
                onClick={handleUpdateClick}
                disabled={updateStatus.status === 'downloading'}
                className={`w-11 h-8 inline-flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                  updateStatus.status === 'downloaded'
                    ? 'text-success-text hover:bg-success-bg'
                    : updateStatus.status === 'downloading'
                      ? 'text-info-text cursor-wait'
                      : 'text-info-text hover:bg-info-bg'
                }`}
                aria-label={
                  updateStatus.status === 'downloaded'
                    ? `Update ${updateStatus.version ?? ''} installieren`
                    : updateStatus.status === 'downloading'
                      ? `Update wird heruntergeladen (${updateStatus.progress ?? 0}%)`
                      : `Update ${updateStatus.version ?? ''} herunterladen`
                }
                title={
                  updateStatus.status === 'downloaded'
                    ? `Neu starten & Update ${updateStatus.version ?? ''} installieren`
                    : updateStatus.status === 'downloading'
                      ? `Herunterladen... ${updateStatus.progress ?? 0}%`
                      : `Update ${updateStatus.version ?? ''} verfügbar`
                }
              >
                {updateStatus.status === 'downloaded' ? (
                  <RefreshCw size={14} />
                ) : updateStatus.status === 'downloading' ? (
                  <ArrowDownToLine size={14} />
                ) : (
                  <ArrowDownToLine size={14} />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={minimize}
              className="w-11 h-8 inline-flex items-center justify-center text-muted hover:bg-surface-muted hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-label="Fenster minimieren"
              title="Minimieren"
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={toggleMaximize}
              className="w-11 h-8 inline-flex items-center justify-center text-muted hover:bg-surface-muted hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-label={isMaximized ? 'Fenster wiederherstellen' : 'Fenster maximieren'}
              title={isMaximized ? 'Wiederherstellen' : 'Maximieren'}
            >
              {isMaximized ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                  <rect x="1" y="3" width="7" height="7" rx="1" />
                  <path d="M4 1h7v7" />
                </svg>
              ) : <Square size={12} aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={close}
              className="w-11 h-8 inline-flex items-center justify-center text-foreground hover:bg-error hover:text-background transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-label="Fenster schließen"
              title="Schließen"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
