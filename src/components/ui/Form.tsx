import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Icon } from './Icon';

interface FieldShellProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Label + control + hint/error wrapper used by every form control. */
export function Field({ label, hint, error, optional, htmlFor, children, className }: FieldShellProps) {
  const t = useT();
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="field__label" htmlFor={htmlFor}>
        <span>{label}</span>
        {optional && <span className="field__optional">{t('common.optional')}</span>}
      </label>
      {children}
      {error ? <span className="field__error">{error}</span> : null}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
  readonly wrapClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, optional, wrapClassName, id, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const control = (
    <input
      ref={ref}
      id={inputId}
      className={['input', className].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
      aria-describedby={hint || error ? `${inputId}-desc` : undefined}
      {...rest}
    />
  );

  if (!label) {
    return (
      <>
        {control}
        {(hint || error) && (
          <span id={`${inputId}-desc`} className={error ? 'field__error' : 'field__hint'}>
            {error ?? hint}
          </span>
        )}
      </>
    );
  }

  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={inputId} className={wrapClassName}>
      {control}
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, optional, id, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const control = (
    <textarea
      ref={ref}
      id={fieldId}
      className={['textarea', className].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={fieldId}>
      {control}
    </Field>
  );
});

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly optional?: boolean;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, optional, options, placeholder, id, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const control = (
    <select
      ref={ref}
      id={selectId}
      className={['select', className].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
      {...rest}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} htmlFor={selectId}>
      {control}
    </Field>
  );
});

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
  readonly id?: string;
}

export function Switch({ checked, onChange, label, hint, disabled, id }: SwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  return (
    <div className="stack stack-1">
      <label className="switch" htmlFor={switchId}>
        <input
          id={switchId}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch__track">
          <span className="switch__thumb" />
        </span>
        <span>{label}</span>
      </label>
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly title?: string;
}

export interface SegmentedProps<T extends string> {
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={['segmented__item', option.value === value ? 'is-active' : ''].filter(Boolean).join(' ')}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface SearchInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly ariaLabel: string;
}

export function SearchInput({ value, onChange, placeholder, ariaLabel }: SearchInputProps) {
  const t = useT();
  return (
    <div className="search-input">
      <span className="search-input__icon" aria-hidden="true">
        <Icon name="search" size={14} />
      </span>
      <input
        className="input"
        type="search"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="btn btn--ghost btn--sm btn--icon search-input__clear"
          aria-label={t('common.clear')}
          onClick={() => onChange('')}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
