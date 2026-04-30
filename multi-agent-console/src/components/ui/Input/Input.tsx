import React, { useId, useState } from 'react';
import styles from './Input.module.css';

/* ============================================================
   Input — Apple HIG 风格输入框
   支持：基础文本输入 / 搜索框 / 带标签 / 错误/帮助文字
   ============================================================ */

export type InputVariant = 'default' | 'search';

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** 输入框变体 */
  variant?: InputVariant;
  /** 字段标签（显示在输入框上方） */
  label?: string;
  /** 左侧图标 */
  iconLeft?: React.ReactNode;
  /** 右侧图标（搜索框无效，由清除按钮占用） */
  iconRight?: React.ReactNode;
  /** 错误信息（非空时显示红色边框 + 错误文字） */
  error?: string;
  /** 帮助提示文字 */
  helpText?: string;
  /** 搜索框是否显示清除按钮 */
  clearable?: boolean;
  /** 清除按钮点击回调 */
  onClear?: () => void;
}

/* SF Symbols 风格：放大镜图标 */
const SearchIcon: React.FC = () => (
  <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
    <path
      d="M7.5 13a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM15 15l-3-3"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

/* SF Symbols 风格：叉号清除图标 */
const ClearIcon: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      variant    = 'default',
      label,
      iconLeft,
      iconRight,
      error,
      helpText,
      clearable  = false,
      onClear,
      className,
      id,
      value,
      onChange,
      ...rest
    },
    ref
  ) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const isSearch = variant === 'search';

    /* 内部受控：用于显示清除按钮 */
    const [internalValue, setInternalValue] = useState(
      rest.defaultValue ?? ''
    );
    const controlled   = value !== undefined;
    const displayValue = controlled ? value : internalValue;
    const showClear    = clearable && String(displayValue).length > 0;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!controlled) setInternalValue(e.target.value);
      onChange?.(e);
    };

    const handleClear = () => {
      if (!controlled) setInternalValue('');
      onClear?.();
    };

    const inputClass = [
      styles.input,
      isSearch          ? styles.search          : '',
      (iconLeft || isSearch) ? styles.hasIconLeft  : '',
      (iconRight && !isSearch && !clearable) ? styles.hasIconRight : '',
      (clearable && showClear) ? styles.hasIconRight : '',
      error             ? styles.inputError       : '',
      className         ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={styles.field}>
        {label && (
          <label htmlFor={inputId} className={styles.label}>
            {label}
          </label>
        )}

        <div className={styles.inputWrapper}>
          {/* 搜索图标 / 自定义左图标 */}
          {(isSearch || iconLeft) && (
            <span className={styles.iconLeft}>
              {isSearch ? <SearchIcon /> : iconLeft}
            </span>
          )}

          <input
            ref={ref}
            id={inputId}
            className={inputClass}
            value={controlled ? value : internalValue}
            onChange={handleChange}
            aria-invalid={!!error}
            aria-describedby={
              error    ? `${inputId}-error`   :
              helpText ? `${inputId}-help`    : undefined
            }
            {...rest}
          />

          {/* 右侧图标 / 清除按钮 */}
          {clearable ? (
            <button
              type="button"
              className={[
                styles.clearBtn,
                showClear ? styles.clearBtnVisible : '',
              ].join(' ')}
              onClick={handleClear}
              aria-label="清除内容"
              tabIndex={showClear ? 0 : -1}
            >
              <ClearIcon />
            </button>
          ) : iconRight ? (
            <span className={styles.iconRight}>{iconRight}</span>
          ) : null}
        </div>

        {/* 错误 / 帮助文字 */}
        {error && (
          <span id={`${inputId}-error`} className={styles.errorMsg} role="alert">
            {error}
          </span>
        )}
        {!error && helpText && (
          <span id={`${inputId}-help`} className={styles.helpText}>
            {helpText}
          </span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
export default Input;
