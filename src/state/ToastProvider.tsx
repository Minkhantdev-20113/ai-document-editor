import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/I18nProvider';
import { Icon, type IconName } from '../components/ui/Icon';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastInput {
  readonly tone?: ToastTone;
  readonly title: string;
  readonly description?: string;
  readonly durationMs?: number;
}

interface ToastItem extends Required<Omit<ToastInput, 'description'>> {
  readonly id: number;
  readonly description: string | undefined;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'alertCircle',
  warning: 'alertTriangle',
  info: 'info',
};

/** Lightweight toast queue: capped, auto-dismissing, portal-rendered. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const sequence = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = (sequence.current += 1);
      const item: ToastItem = {
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        description: input.description,
        durationMs: input.durationMs ?? (input.tone === 'error' ? 7000 : 4200),
      };
      setItems((current) => [...current.slice(-3), item]);
      if (item.durationMs > 0) {
        setTimeout(() => dismiss(id), item.durationMs);
      }
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: 'success', title, ...(description ? { description } : {}) }),
      error: (title, description) => toast({ tone: 'error', title, ...(description ? { description } : {}) }),
      warning: (title, description) => toast({ tone: 'warning', title, ...(description ? { description } : {}) }),
      info: (title, description) => toast({ tone: 'info', title, ...(description ? { description } : {}) }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="toast-region" role="region" aria-label={t('toast.info')}>
            {items.map((item) => (
              <div key={item.id} className={`toast toast--${item.tone}`} role="status">
                <Icon name={TONE_ICON[item.tone]} size={16} />
                <div className="toast__content">
                  <div className="toast__title">{item.title}</div>
                  {item.description && <div className="toast__description">{item.description}</div>}
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm btn--icon"
                  aria-label={t('common.close')}
                  onClick={() => dismiss(item.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
