import React from 'react';
import { ArrowDownToLine, Copy, Minus, RefreshCw, Square, X } from 'lucide-react';
import { ipc } from '../ipc/client';
import billmeMarkLogo from '../assets/billme-mark.svg';

export const Titlebar: React.FC = () => {
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
    void syncWindowState();

    window.billmeWindow?.onMaximizeChanged((state) => {
      setIsMaximized(Boolean(state?.isMaximized));
    });

    return () => {
      window.billmeWindow?.offMaximizeChanged?.();
    };
  }, [syncWindowState]);

  React.useEffect(() => {
    ipc.updater.getStatus().then(setUpdateStatus).catch(() => {});

    window.billmeWindow?.onUpdateStatusChanged((payload) => {
      setUpdateStatus(payload);
    });

    return () => {
      window.billmeWindow?.offUpdateStatusChanged?.();
    };
  }, []);

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

  return (
    <div
      className="drag-region h-10 shrink-0 border-b border-black/10 bg-white/95 backdrop-blur-sm flex items-center justify-between pl-3 pr-1 select-none no-print"
      onDoubleClick={toggleMaximize}
    >
      <div className="flex items-center gap-2 min-w-0">
        <img
          src={billmeMarkLogo}
          alt="Billme"
          className="w-5 h-5 object-contain"
          draggable={false}
        />
        <span className="text-xs font-bold tracking-wide text-black/80 truncate">Billme</span>
      </div>

      <div className="no-drag flex items-center" onDoubleClick={(e) => e.stopPropagation()}>
        {showUpdateButton && (
          <button
            type="button"
            onClick={handleUpdateClick}
            disabled={updateStatus.status === 'downloading'}
            className={`w-11 h-8 inline-flex items-center justify-center transition-colors ${
              updateStatus.status === 'downloaded'
                ? 'text-green-600 hover:bg-green-50 hover:text-green-700'
                : updateStatus.status === 'downloading'
                  ? 'text-blue-500 cursor-wait'
                  : 'text-blue-600 hover:bg-blue-50 hover:text-blue-700'
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
              <ArrowDownToLine size={14} className="animate-pulse" />
            ) : (
              <ArrowDownToLine size={14} />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={minimize}
          className="w-11 h-8 inline-flex items-center justify-center text-gray-600 hover:bg-gray-100 hover:text-black transition-colors"
          aria-label="Fenster minimieren"
          title="Minimieren"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={toggleMaximize}
          className="w-11 h-8 inline-flex items-center justify-center text-gray-600 hover:bg-gray-100 hover:text-black transition-colors"
          aria-label={isMaximized ? 'Fenster wiederherstellen' : 'Fenster maximieren'}
          title={isMaximized ? 'Wiederherstellen' : 'Maximieren'}
        >
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          type="button"
          onClick={close}
          className="w-11 h-8 inline-flex items-center justify-center text-gray-700 hover:bg-red-600 hover:text-white transition-colors"
          aria-label="Fenster schließen"
          title="Schließen"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
