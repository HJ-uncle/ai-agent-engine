import React from 'react';
import styles from './Navigation.module.css';

/* ============================================================
   Navigation — Apple HIG 导航组件
   导出：TopBar（顶部标题栏）/ Sidebar（侧边栏容器）/ NavItem（导航项）
   ============================================================ */

/* ============================
   TopBar · 顶部标题栏
   ============================ */
export interface TopBarProps {
  /** 页面标题 */
  title?: React.ReactNode;
  /** 左侧插槽（返回按钮等） */
  left?: React.ReactNode;
  /** 右侧插槽（操作按钮等） */
  right?: React.ReactNode;
  className?: string;
}

/* SF Symbols 风格：左箭头返回 */
const ChevronLeftIcon: React.FC = () => (
  <svg width="10" height="17" viewBox="0 0 10 17" fill="none" aria-hidden="true">
    <path d="M9 1L1 8.5 9 16" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

/* SF Symbols 风格：加号 */
const PlusIcon: React.FC = () => (
  <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
    <path d="M8.5 1v15M1 8.5h15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
  </svg>
);

export const TopBar: React.FC<TopBarProps> = ({
  title,
  left,
  right,
  className,
}) => (
  <header className={[styles.topBar, className ?? ''].join(' ')}>
    <div className={styles.topBarLeft}>
      {left}
    </div>

    {title && (
      <h1 className={styles.topBarTitle}>
        {title}
      </h1>
    )}

    <div className={styles.topBarRight}>
      {right}
    </div>
  </header>
);

/** 标题栏文字/图标按钮 */
export interface TopBarButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
}
export const TopBarButton: React.FC<TopBarButtonProps> = ({
  children,
  className,
  ...rest
}) => (
  <button
    type="button"
    className={[styles.topBarBtn, className ?? ''].join(' ')}
    {...rest}
  >
    {children}
  </button>
);

/** 标题栏返回按钮 */
export interface BackButtonProps {
  label?: string;
  onClick?: () => void;
}
export const BackButton: React.FC<BackButtonProps> = ({
  label = '返回',
  onClick,
}) => (
  <button
    type="button"
    className={[styles.topBarBtn, styles.backBtn].join(' ')}
    onClick={onClick}
    aria-label={`返回 ${label}`}
  >
    <ChevronLeftIcon />
    <span>{label}</span>
  </button>
);

/* ============================
   Sidebar · 侧边栏容器
   ============================ */
export interface SidebarProps {
  children?: React.ReactNode;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ children, className }) => (
  <nav
    className={[styles.sidebar, className ?? ''].join(' ')}
    aria-label="主导航"
  >
    {children}
  </nav>
);

/** 侧边栏分区标题 */
export const SidebarSectionTitle: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <p className={styles.sidebarSectionTitle}>{children}</p>;

/** 侧边栏分割线 */
export const SidebarDivider: React.FC = () => (
  <hr className={styles.sidebarDivider} />
);

/* ============================
   NavItem · 侧边栏导航项
   ============================ */
export interface NavItemProps {
  /** 显示标签 */
  label: string;
  /** 左侧图标 */
  icon?: React.ReactNode;
  /** 是否当前激活 */
  active?: boolean;
  /** 右侧徽章数字（> 0 时显示） */
  badge?: number;
  /** 点击回调 */
  onClick?: () => void;
  /** 作为链接渲染 */
  href?: string;
  className?: string;
}

export const NavItem: React.FC<NavItemProps> = ({
  label,
  icon,
  active = false,
  badge,
  onClick,
  href,
  className,
}) => {
  const cls = [
    styles.navItem,
    active ? styles.navItemActive : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {icon && (
        <span className={styles.navItemIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.navItemLabel}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className={styles.navItemBadge} aria-label={`${badge} 条未读`}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={cls}
        aria-current={active ? 'page' : undefined}
      >
        {inner}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {inner}
    </button>
  );
};

/* 导出常用图标供外部传入 icon prop */
export { ChevronLeftIcon, PlusIcon };
