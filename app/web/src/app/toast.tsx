import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onApiError } from '../api/client.js';

export interface ToastMessage {
  id: number;
  message: string;
  type: 'error' | 'success' | 'info';
}

interface ToastContextValue {
  toasts: ToastMessage[];
  pushToast: (message: string, type?: ToastMessage['type']) => void;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, type }]);
    window.setTimeout(() => dismissToast(id), 6000);
  }, [dismissToast]);

  useEffect(() => {
    return onApiError((error) => {
      pushToast(error.message, 'error');
    });
  }, [pushToast]);

  const value = useMemo(
    () => ({ toasts, pushToast, dismissToast }),
    [toasts, pushToast, dismissToast],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastContainer() {
  const { toasts, dismissToast } = useToast();

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-md flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded-lg border px-4 py-3 shadow-lg ${
            toast.type === 'error'
              ? 'border-danger/30 bg-danger/10 text-danger'
              : toast.type === 'success'
                ? 'border-ok/30 bg-ok/10 text-ok'
                : 'border-border bg-card text-ink'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm">{toast.message}</p>
            <button
              type="button"
              className="text-muted hover:text-ink"
              onClick={() => dismissToast(toast.id)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
