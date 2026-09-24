import React from 'react';
import { ArrowDownToLine, LogOut, Minus, RefreshCw, Square, X } from 'lucide-react';
import { getRendererRuntime, ipc } from '../runtime-api';

type UpdateStatus = { status: string; version?: string; progress?: number };

/**
 * Window events exposed by the Electron preload. Absent in the browser shells,
 * whose tsconfigs do not declare `window.billmeWindow`, so it is read through
 * a typed accessor.
 */
type WindowBridge = {
  onMaximizeChanged: (callback: (state: { isMaximized?: boolean }) => void) => void;
  offMaximizeChanged?: () => void;
  onUpdateStatusChanged: (callback: (payload: UpdateStatus) => void) => void;
  offUpdateStatusChanged?: () => void;
};

const getWindowBridge = (): WindowBridge | undefined => {
  const bridge: unknown = Reflect.get(globalThis, 'billmeWindow');
  return typeof bridge === 'object' && bridge !== null && 'onMaximizeChanged' in bridge
    ? (bridge as WindowBridge)
    : undefined;
};

const windowButton =
  'w-11 h-8 inline-flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export interface TitlebarProps {
  logoSrc: string;
}

/**
 * Frameless-window title bar shared by Lite and Pro. In the Electron shell it
 * carries the update button and window controls; in the web shell those make
 * no sense, so it shows sign-out instead.
 */
export const Titlebar: React.FC<TitlebarProps> = ({ logoSrc }) => {
  const runtime = React.useMemo(() => getRendererRuntime(), []);
  const isWebShell = runtime.shell === 'web';
  const [isMaximized, setIsMaximized] = React.useState(false);
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus>({ status: 'idle' });

  React.useEffect(() => {
    if (isWebShell) return undefined;
    ipc.window.isMaximized()
      .then((state) => setIsMaximized(state.isMaximized))
      .catch(() => {
        // Ignore state sync errors in non-Electron fallback environments.
      });
    const bridge = getWindowBridge();
    bridge?.onMaximizeChanged((state) => setIsMaximized(Boolean(state?.isMaximized)));
    return () => bridge?.offMaximizeChanged?.();
  }, [isWebShell]);

  React.useEffect(() => {
    if (isWebShell) return undefined;
    ipc.updater.getStatus().then(setUpdateStatus).catch(() => {});
    const bridge = getWindowBridge();
    bridge?.onUpdateStatusChanged(setUpdateStatus);
    return () => bridge?.offUpdateStatusChanged?.();
  }, [isWebShell]);

  const toggleMaximize = () => {
    if (!isWebShell) void ipc.window.toggleMaximize();
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

  return (
    <div
      className="drag-region h-10 shrink-0 bg-surface-sunken flex items-center justify-between pl-3 pr-1 select-none no-print"
      onDoubleClick={toggleMaximize}
    >
      <div className="flex items-center gap-2 min-w-0">
        <img src={logoSrc} alt="Billme" className="w-5 h-5 object-contain" draggable={false} />
        <span className="text-caption font-medium text-muted truncate">Billme</span>
      </div>

      <div className="no-drag flex items-center" onDoubleClick={(e) => e.stopPropagation()}>
        {isWebShell ? (
          runtime.onLogout ? (
            <button
              type="button"
              onClick={() => runtime.onLogout?.()}
              className="inline-flex h-8 items-center gap-2 rounded-control px-3 text-caption font-medium text-foreground transition-colors hover:bg-ink-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
                className={`${windowButton} ${
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
                {updateStatus.status === 'downloaded'
                  ? <RefreshCw size={14} aria-hidden="true" />
                  : <ArrowDownToLine size={14} aria-hidden="true" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => void ipc.window.minimize()}
              className={`${windowButton} text-muted hover:bg-ink-100 hover:text-foreground`}
              aria-label="Fenster minimieren"
              title="Minimieren"
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={toggleMaximize}
              className={`${windowButton} text-muted hover:bg-ink-100 hover:text-foreground`}
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
              onClick={() => void ipc.window.close()}
              className={`${windowButton} text-foreground hover:bg-error hover:text-background`}
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
