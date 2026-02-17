import React from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { ipc } from '../ipc/client';
import billmeMarkLogo from '../assets/billme-mark.svg';

export const Titlebar: React.FC = () => {
  const [isMaximized, setIsMaximized] = React.useState(false);

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

  const minimize = () => {
    void ipc.window.minimize();
  };

  const toggleMaximize = () => {
    void ipc.window.toggleMaximize();
  };

  const close = () => {
    void ipc.window.close();
  };

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
