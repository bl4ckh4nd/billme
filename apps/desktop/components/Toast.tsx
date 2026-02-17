import { useEffect, type ReactElement } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  message: string;
  type: ToastType;
  isVisible: boolean;
  onClose: () => void;
  duration?: number;
}

export function Toast({ message, type, isVisible, onClose, duration = 3000 }: ToastProps): ReactElement | null {
  useEffect(() => {
    if (isVisible && duration > 0) {
      const timer = setTimeout(() => {
        onClose();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [isVisible, duration, onClose]);

  if (!isVisible) return null;

  const typeConfig = {
    success: {
      icon: CheckCircle2,
      bgColor: 'bg-success-bg',
      borderColor: 'border-success/30',
      textColor: 'text-success',
      iconColor: 'text-success',
    },
    error: {
      icon: XCircle,
      bgColor: 'bg-error-bg',
      borderColor: 'border-error/30',
      textColor: 'text-error',
      iconColor: 'text-error',
    },
    warning: {
      icon: AlertTriangle,
      bgColor: 'bg-yellow-50',
      borderColor: 'border-yellow-200',
      textColor: 'text-yellow-800',
      iconColor: 'text-yellow-600',
    },
    info: {
      icon: Info,
      bgColor: 'bg-info-bg',
      borderColor: 'border-info/30',
      textColor: 'text-info',
      iconColor: 'text-info',
    },
  };

  const config = typeConfig[type];
  const Icon = config.icon;

  return (
    <div className="fixed top-4 right-4 z-50 animate-in slide-in-from-top-2 fade-in duration-200">
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${config.bgColor} ${config.borderColor} shadow-lg max-w-md`}
      >
        <Icon size={20} className={config.iconColor} />
        <p className={`text-sm font-medium ${config.textColor} flex-1`}>{message}</p>
        <button
          onClick={onClose}
          className={`p-1 hover:bg-black/5 rounded transition-colors ${config.textColor}`}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
