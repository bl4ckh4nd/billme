import React from 'react';
import { cn } from '../utils/cn';

export type InputVariant = 'text' | 'numeric' | 'currency' | 'percent';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'value'> {
  label?: string;
  error?: string;
  hint?: React.ReactNode;
  fullWidth?: boolean;
  variant?: InputVariant;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  value?: React.InputHTMLAttributes<HTMLInputElement>['value'] | null;
  onValueChange?: (value: number | null) => void;
}

const inputValueToString = (value: React.InputHTMLAttributes<HTMLInputElement>['value'] | null): string => {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join('');
  return String(value);
};

/** Parse the decimal separators used by German users while accepting the keyboard's dot too. */
export const parseGermanNumber = (value: string): number | null => {
  const compact = value.trim().replace(/\s+/g, '');
  if (!compact) return null;

  const sign = compact.startsWith('-') || compact.startsWith('+') ? compact.slice(0, 1) : '';
  const unsigned = sign ? compact.slice(1) : compact;
  if (!unsigned || !/^(?:\d|[.,])/.test(unsigned)) return null;

  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');
  const hasComma = lastComma !== -1;
  const hasDot = lastDot !== -1;

  let integerPart = unsigned;
  let fractionPart = '';

  if (hasComma || hasDot) {
    const separator = lastComma > lastDot ? ',' : '.';
    const separatorCount = [...unsigned].filter((character) => character === separator).length;
    const groups = unsigned.split(separator);
    const allGroupsAreThousands = separatorCount > 1
      && groups[0] !== ''
      && groups.slice(1).every((group) => /^\d{3}$/.test(group));

    if (allGroupsAreThousands && !unsigned.includes(separator === ',' ? '.' : ',')) {
      integerPart = unsigned;
    } else {
      const separatorIndex = unsigned.lastIndexOf(separator);
      integerPart = unsigned.slice(0, separatorIndex);
      fractionPart = unsigned.slice(separatorIndex + 1);
    }
  }

  const integerGroups = integerPart ? integerPart.split(/[.,]/) : [''];
  if (integerGroups.some((group) => group !== '' && !/^\d+$/.test(group)) || !/^\d*$/.test(fractionPart)) return null;
  if (integerGroups.length === 1 && integerGroups[0] === '' && !fractionPart) return null;
  if (integerGroups.length > 1 && (integerGroups[0]!.length < 1 || integerGroups[0]!.length > 3 || integerGroups.slice(1).some((group) => group.length !== 3))) {
    return null;
  }

  const normalized = `${sign}${integerGroups.join('') || '0'}${fractionPart ? `.${fractionPart}` : ''}`;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({
    label,
    error,
    hint,
    fullWidth = false,
    variant = 'text',
    prefix,
    suffix,
    onValueChange,
    className,
    id,
    value,
    defaultValue,
    onChange,
    onFocus,
    onBlur,
    type,
    inputMode,
    required,
    readOnly,
    'aria-describedby': ariaDescribedBy,
    ...props
  }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const isNumeric = variant !== 'text';
    const [rawValue, setRawValue] = React.useState(() => inputValueToString(value === undefined ? defaultValue : value));
    const [isFocused, setIsFocused] = React.useState(false);
    const lastExternalValue = React.useRef(inputValueToString(value));
    const previousVariant = React.useRef(variant);

    React.useEffect(() => {
      if (!isNumeric) return;
      const nextExternalValue = inputValueToString(value);
      if (previousVariant.current !== variant) {
        previousVariant.current = variant;
        lastExternalValue.current = nextExternalValue;
        setRawValue(nextExternalValue);
        return;
      }
      if (nextExternalValue === lastExternalValue.current) return;
      lastExternalValue.current = nextExternalValue;
      if (!isFocused) setRawValue(nextExternalValue);
    }, [isFocused, isNumeric, value, variant]);

    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;
    const hasHint = hint !== undefined && hint !== null && hint !== false;
    const describedBy = [ariaDescribedBy, hasHint ? hintId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      if (isNumeric) setRawValue(event.target.value);
      onChange?.(event);
    };
    const handleFocus = (event: React.FocusEvent<HTMLInputElement>) => {
      if (isNumeric) setIsFocused(true);
      onFocus?.(event);
    };
    const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
      if (isNumeric) {
        setIsFocused(false);
        onValueChange?.(parseGermanNumber(rawValue));
      }
      onBlur?.(event);
    };

    const input = (
      <input
        id={inputId}
        ref={ref}
        type={isNumeric ? 'text' : type}
        inputMode={isNumeric ? inputMode ?? 'decimal' : inputMode}
        value={isNumeric ? rawValue : value ?? undefined}
        defaultValue={isNumeric ? undefined : defaultValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={cn(
          'min-h-8.5 bg-surface border rounded-control px-2.25 py-1.5 text-foreground text-control',
          'transition-[border-color,box-shadow,outline-color] motion-reduce:transition-none hover:border-control-border-hover',
          'placeholder:text-muted',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus-ring focus-visible:border-transparent',
          'disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:placeholder:text-disabled-foreground disabled:cursor-not-allowed disabled:opacity-100',
          isNumeric && 'text-right font-mono tabular-nums',
          readOnly && 'bg-surface-sunken read-only:text-muted',
          (prefix !== undefined && prefix !== null) && 'pl-8',
          (suffix !== undefined && suffix !== null) && 'pr-8',
          error ? 'border-error' : 'border-control-border',
          fullWidth && 'w-full',
          className,
        )}
        {...props}
        required={required}
        readOnly={readOnly}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy}
        aria-required={required ? true : props['aria-required']}
      />
    );

    return (
      <div className={cn('text-foreground', fullWidth && 'w-full')}>
        {label && (
          <div className="mb-1 flex items-baseline">
            <label htmlFor={inputId} className="block text-caption font-medium text-foreground-secondary">
              {label}
            </label>
            {/* outside the <label> so the accessible name stays exactly `label` */}
            {required && (
              <span aria-hidden="true" className="ml-0.5 text-caption text-error-text">*</span>
            )}
          </div>
        )}
        {(prefix !== undefined && prefix !== null) || (suffix !== undefined && suffix !== null) ? (
          <div className="relative">
            {prefix !== undefined && prefix !== null ? (
              <span className="pointer-events-none absolute inset-y-0 left-2.25 flex items-center text-control text-muted" aria-hidden="true">
                {prefix}
              </span>
            ) : null}
            {input}
            {suffix !== undefined && suffix !== null ? (
              <span className="pointer-events-none absolute inset-y-0 right-2.25 flex items-center text-control text-muted" aria-hidden="true">
                {suffix}
              </span>
            ) : null}
          </div>
        ) : input}
        {hasHint && <span id={hintId} className="mt-1 block text-micro text-muted">{hint}</span>}
        {error && (
          <p id={errorId} className="mt-1 text-caption text-error-text">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
