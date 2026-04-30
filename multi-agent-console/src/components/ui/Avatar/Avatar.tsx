import React, { useState } from 'react';
import styles from './Avatar.module.css';

/* ============================================================
   Avatar — Apple HIG 风格头像
   支持：图片 / 首字母 Fallback / 状态圆点 / 多种尺寸 / 方形
   ============================================================ */

export type AvatarSize   = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
export type AvatarColor  =
  | 'blue' | 'green' | 'orange' | 'purple'
  | 'pink' | 'indigo' | 'teal'  | 'red';
export type AvatarStatus = 'online' | 'away' | 'busy' | 'offline';

export interface AvatarProps {
  /** 图片地址 */
  src?: string;
  /** 图片 alt（无图时从 name 提取首字母） */
  alt?: string;
  /** 用户名（用于生成首字母和 aria-label） */
  name?: string;
  /** 头像尺寸 */
  size?: AvatarSize;
  /** 无图时的背景颜色 */
  color?: AvatarColor;
  /** 方形（App Icon 风格） */
  square?: boolean;
  /** 显示叠排描边 */
  bordered?: boolean;
  /** 在线状态圆点 */
  status?: AvatarStatus;
  /** 可点击 */
  onClick?: () => void;
  className?: string;
}

/** 从名字提取首字母（最多 2 个字符） */
const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/** 根据名字确定一个稳定的颜色（hash 取模） */
const AUTO_COLORS: AvatarColor[] = [
  'blue', 'green', 'orange', 'purple', 'pink', 'indigo', 'teal', 'red',
];
const nameToColor = (name: string): AvatarColor => {
  const code = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AUTO_COLORS[code % AUTO_COLORS.length];
};

/** 人物轮廓 SVG（无 name 时的兜底） */
const PersonIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
       style={{ width: '55%', height: '55%' }}>
    <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export const Avatar: React.FC<AvatarProps> = ({
  src,
  alt,
  name,
  size     = 'md',
  color,
  square   = false,
  bordered = false,
  status,
  onClick,
  className,
}) => {
  const [imgError, setImgError] = useState(false);
  const resolvedColor = color ?? (name ? nameToColor(name) : 'blue');

  const showImage   = !!src && !imgError;
  const showInitial = !showImage && !!name;

  const rootClass = [
    styles.avatar,
    styles[size],
    !showImage ? styles[`color${resolvedColor.charAt(0).toUpperCase() + resolvedColor.slice(1)}`] : '',
    square    ? styles.square    : '',
    bordered  ? styles.bordered  : '',
    onClick   ? styles.clickable : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const ariaLabel = alt ?? name ?? '用户头像';

  const inner = (
    <>
      {showImage && (
        <img
          src={src}
          alt={ariaLabel}
          className={styles.image}
          draggable={false}
          onError={() => setImgError(true)}
        />
      )}

      {showInitial && (
        <span className={styles.initials} aria-hidden="true">
          {getInitials(name!)}
        </span>
      )}

      {!showImage && !showInitial && (
        <span style={{ color: 'rgba(255,255,255,0.85)', display: 'flex' }}>
          <PersonIcon />
        </span>
      )}

      {/* 在线状态圆点 */}
      {status && (
        <span
          className={[
            styles.statusDot,
            status !== 'online' ? styles[status] : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label={
            status === 'online'  ? '在线'   :
            status === 'away'    ? '离开'   :
            status === 'busy'    ? '忙碌'   : '离线'
          }
        />
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={rootClass}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {inner}
      </button>
    );
  }

  return (
    <span className={rootClass} aria-label={ariaLabel}>
      {inner}
    </span>
  );
};

/** 头像组（堆叠展示多人） */
export interface AvatarGroupProps {
  avatars: Array<Omit<AvatarProps, 'bordered'>>;
  max?: number;
  size?: AvatarSize;
}

export const AvatarGroup: React.FC<AvatarGroupProps> = ({
  avatars,
  max = 5,
  size = 'md',
}) => {
  const visible  = avatars.slice(0, max);
  const overflow = avatars.length - max;

  return (
    <div className={styles.group}>
      {visible.map((props, i) => (
        <Avatar key={i} {...props} size={size} bordered />
      ))}
      {overflow > 0 && (
        <Avatar
          name={`+${overflow}`}
          size={size}
          bordered
          color="blue"
        />
      )}
    </div>
  );
};

export default Avatar;
