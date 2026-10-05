import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { Button, IconButton } from './Button';

export interface ModalProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly wide?: boolean;
  /** Disables backdrop/ESC dismissal for destructive confirmation flows. */
  readonly blocked?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal: portal, focus trap, ESC + backdrop dismissal,
 * scroll lock and focus restoration to the previously focused element.
 */
export function Modal({ open, title, description, onClose, children, footer, wide, blocked }: ModalProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? dialog)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !blocked) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose, blocked]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!blocked && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={['modal', wide ? 'modal--wide' : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
      >
        <header className="modal__header">
          <div>
            <h2 className="modal__title">{title}</h2>
            {description && <p className="modal__description">{description}</p>}
          </div>
          <IconButton label={t('common.close')} variant="ghost" size="sm" onClick={onClose} />
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      blocked={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <p className="muted">{body}</p>
    </Modal>
  );
}
