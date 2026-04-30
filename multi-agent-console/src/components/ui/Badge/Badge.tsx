import React from 'react';
import styles from './Badge.module.css';

/* ============================================================
   Badge / Label — Apple HIG 风格徽章与标签
   导出：Badge（数字/圆点）/ Label（文字标签）/ BadgeWrapper（角标叠加）
   ============================================================ */

/* ============================
   Badge · 数字徽章 / 圆点
   ============================ */

export type BadgeColor = 'red' | 'blue' | 'green' | 'orange' | 'gray';

export interface BadgeProps {
  /** 显示的数字或文字（不传则渲染为小圆点） */
  count?: number | string;
  /** 最大值，超过显示 max+ */
  max?: number;
  /** 颜色变体 */
  color?: BadgeColor;
  /** 强制以小圆点渲染（忽略 count） */
  dot?: boolean;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  count,
  max     = 99,
  color   = 'red',
  dot     = false,
  className,
}) => {
  const colorClass =
    color === 'blue'   ? styles.badgeBlue   :
    color === 'green'  ? styles.badgeGreen  :
    color === 'orange' ? styles.badgeOrange :
    color === 'gray'   ? styles.badgeGray   :
    styles.badgeRed;

  const isDot = dot || count === undefined;

  const cls = [
    styles.badge,
    colorClass,
    isDot ? styles.dot : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  let display: React.ReactNode = null;
  if (!isDot) {
    if (typeof count === 'number') {
      display = count > max ? `${max}+` : count;
    } else {
      display = count;
    }
  }

  return (
    <span className={cls} aria-label={isDot ? undefined : `${display}`}>
      {display}
    </span>
  );
};

/* ============================
   BadgeWrapper · 角标容器
   将 Badge 叠加到子元素右上角
   ============================ */
export interface BadgeWrapperProps {
  badge: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const BadgeWrapper: React.FC<BadgeWrapperProps> = ({
  badge,
  children,
  className,
}) => (
  <span className={[styles.badgeWrapper, className ?? ''].join(' ')}>
    {children}
    <span className={styles.badgeAnchor}>{badge}</span>
  </span>
);

/* ============================
   Label · 文字标签 / Tag
   ============================ */
export type LabelColor   = 'default' | 'blue' | 'green' | 'orange' | 'red';
export type LabelVariant = 'filled' | 'pill' | 'outlined';

export interface LabelProps {
  children: React.ReactNode;
  /** 颜色语义 */
  color?: LabelColor;
  /** 外观变体：filled（方形）/ pill（胶囊）/ outlined（描边） */
  variant?: LabelVariant;
  /** 左侧图标（SVG，12px） */
  icon?: React.ReactNode;
  className?: string;
}

export const Label: React.FC<LabelProps> = ({
  children,
  color   = 'default',
  variant = 'filled',
  icon,
  className,
}) => {
  const colorClass =
    color === 'blue'   ? styles.labelBlue   :
    color === 'green'  ? styles.labelGreen  :
    color === 'orange' ? styles.labelOrange :
    color === 'red'    ? styles.labelRed    :
    styles.labelDefault;

  const cls = [
    styles.label,
    colorClass,
    variant === 'pill'     ? styles.labelPill     : '',
    variant === 'outlined' ? styles.labelOutlined : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls}>
      {icon && (
        <span className={styles.labelIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
};

export default Badge;
