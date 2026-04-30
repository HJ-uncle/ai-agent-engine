import React from 'react';
import styles from './Card.module.css';

/* ============================================================
   Card — Apple HIG 风格卡片
   支持：可点击 / 静态信息卡片 / 毛玻璃变体 / 分组背景变体
   ============================================================ */

export type CardVariant = 'default' | 'grouped' | 'glass';

export interface CardProps {
  /** 是否可点击（渲染为 <button> 或 <a>） */
  clickable?: boolean;
  /** 视觉变体 */
  variant?: CardVariant;
  /** 封面图 URL */
  coverSrc?: string;
  coverAlt?: string;
  /** 标题 */
  title?: React.ReactNode;
  /** 副标题 */
  subtitle?: React.ReactNode;
  /** 正文描述 */
  description?: React.ReactNode;
  /** 底部操作区 */
  footer?: React.ReactNode;
  /** 是否显示右侧箭头（仅 clickable 时有效） */
  showChevron?: boolean;
  /** 自定义内容（完全覆盖 title/subtitle/description 插槽） */
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
  href?: string;
  style?: React.CSSProperties;
}

/* SF Symbols 风格：右箭头 */
const ChevronIcon: React.FC = () => (
  <svg width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true">
    <path d="M1 1l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export const Card: React.FC<CardProps> = ({
  clickable    = false,
  variant      = 'default',
  coverSrc,
  coverAlt     = '',
  title,
  subtitle,
  description,
  footer,
  showChevron  = false,
  children,
  className,
  onClick,
  href,
  style,
}) => {
  const rootClass = [
    styles.card,
    variant !== 'default' ? styles[variant] : '',
    clickable ? styles.clickable : styles.static,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {coverSrc && (
        <img
          src={coverSrc}
          alt={coverAlt}
          className={styles.cover}
          draggable={false}
        />
      )}

      {/* 自定义内容优先；否则使用插槽渲染 */}
      {children ? (
        <div className={styles.body}>{children}</div>
      ) : (title || subtitle || description) ? (
        <div className={styles.body}>
          {title       && <h3 className={styles.title}>{title}</h3>}
          {subtitle    && <p  className={styles.subtitle}>{subtitle}</p>}
          {description && <p  className={styles.description}>{description}</p>}
        </div>
      ) : null}

      {footer && <div className={styles.footer}>{footer}</div>}

      {clickable && showChevron && (
        <span className={styles.chevron}>
          <ChevronIcon />
        </span>
      )}
    </>
  );

  /* 可点击：渲染为 <a> 或 <button> */
  if (clickable) {
    if (href) {
      return (
        <a href={href} className={rootClass} style={style}>
          {inner}
        </a>
      );
    }
    return (
      <button
        type="button"
        className={rootClass}
        style={style}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className={rootClass} style={style}>
      {inner}
    </div>
  );
};

export default Card;
