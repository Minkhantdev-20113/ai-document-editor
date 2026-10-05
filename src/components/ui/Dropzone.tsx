import { useRef, useState, type DragEvent } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Icon } from './Icon';

export interface DropzoneProps {
  readonly accept?: string;
  readonly onFile: (file: File) => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly hint?: string;
}

/** Pointer + keyboard accessible file picker (label wraps a hidden input). */
export function Dropzone({ accept, onFile, disabled, title, hint }: DropzoneProps) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  }

  return (
    <div
      className={['dropzone', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ')}
      role="button"
      tabIndex={0}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <Icon name="fileText" size={22} />
      <p className="dropzone__title">{title ?? t('projects.dropFile')}</p>
      <p className="dropzone__hint">{hint ?? t('projects.dropFileHint', { size: '200 MB' })}</p>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
