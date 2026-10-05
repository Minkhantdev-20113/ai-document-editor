import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly icon?: ReactNode;
  readonly iconRight?: ReactNode;
  readonly block?: boolean;
  readonly iconOnly?: boolean;
}

function classes({ variant = 'secondary', size = 'md', block, iconOnly, className }: CommonProps & { className?: string }): string {
  return [
    'btn',
    `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    block ? 'btn--block' : '',
    iconOnly ? 'btn--icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading = false, icon, iconRight, block, iconOnly, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes({ variant, size, block, iconOnly, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});

export type ButtonLinkProps = CommonProps & LinkProps;

/** Router link styled exactly like a button (keeps navigation accessible). */
export function ButtonLink({
  variant,
  size,
  icon,
  iconRight,
  block,
  iconOnly,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={classes({ variant, size, block, iconOnly, className })} {...rest}>
      {icon}
      {children}
      {iconRight}
    </Link>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'iconOnly'> & { readonly label: string };

/** Icon-only button with a mandatory accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, title, ...rest },
  ref,
) {
  return <Button ref={ref} iconOnly aria-label={label} title={title ?? label} {...rest} />;
});
