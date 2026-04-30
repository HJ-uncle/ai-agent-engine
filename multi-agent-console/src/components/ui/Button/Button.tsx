import React from 'react';
import styles from './Button.module.css';

/* ============================================================
   Button — Apple HIG 风格按钮组件
   支持 primary / secondary / ghost / danger 四种变体
   支持 default / compact / large 三种尺寸
   支持 disabled / loading 状态
   ============================================================ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize    = 'default' | 'compact' | 'large';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体 */
  variant?: ButtonVariant;
  /** 尺寸 */
  size?: ButtonSize;
  /** 展示 loading 旋转图标并禁用交互 */
  loading?: boolean;
  /** 左侧图标（传入 JSX，16-20px SVG 推荐） */
  iconLeft?: React.ReactNode;
  /** 右侧图标 */
  iconRight?: React.ReactNode;
  /** 仅图标模式（只传 iconLeft，不传 children） */
  iconOnly?: boolean;
  /** 占满父容器宽度 */
  fullWidth?: boolean;
  /** 作为 <a> 渲染时使用 */
  href?: string;
}

/** SF Symbols 风格：内联旋转加载圈 */
const LoadingIcon: React.FC = () => (
  <svg
    width="16" height="16" viewBox="0 0 16 16"
    fill="none" xmlns="http://www.w3.org/2000/svg"
    style={{ animation: 'btn-spin 0.8s linear infinite' }}
    aria-hidden="true"
  >
    <style>{`@keyframes btn-spin { to { transform: rotate(360deg); } }`}</style>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.3"/>
    <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant   = 'primary',
      size      = 'default',
      loading   = false,
      iconLeft,
      iconRight,
      iconOnly  = false,
      fullWidth = false,
      disabled,
      children,
      className,
      href,
      ...rest
    },
    ref
  ) => {
    const classNames = [
      styles.btn,
      styles[variant],
      size !== 'default' ? styles[size] : '',
      fullWidth  ? styles.fullWidth  : '',
      iconOnly   ? styles.iconOnly   : '',
      loading    ? styles.loading    : '',
      className  ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    const content = (
      <>
        {loading ? (
          <span className={styles.iconWrapper}>
            <LoadingIcon />
          </span>
        ) : iconLeft ? (
          <span className={styles.iconWrapper} aria-hidden="true">
            {iconLeft}
          </span>
        ) : null}

        {!iconOnly && children && <span>{children}</span>}

        {!loading && iconRight && (
          <span className={styles.iconWrapper} aria-hidden="true">
            {iconRight}
          </span>
        )}
      </>
    );

    /* 支持渲染为 <a> 标签（如 href 存在） */
    if (href) {
      return (
        <a href={href} className={classNames} role="button">
          {content}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        className={classNames}
        disabled={disabled || loading}
        {...rest}
      >
        {content}
      </button>
    );
  }
);

Button.displayName = 'Button';
export default Button;
