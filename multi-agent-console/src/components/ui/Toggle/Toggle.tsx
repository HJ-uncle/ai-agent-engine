import React, { useId, useState } from 'react';
import styles from './Toggle.module.css';

/* ============================================================
   Toggle / Switch — Apple HIG 风格开关
   完整复现 iOS UISwitch 交互：滑块拉伸 + 弹性动画
   ============================================================ */

export type ToggleColor = 'green' | 'accent';

export interface ToggleProps {
  /** 受控选中值 */
  checked?: boolean;
  /** 默认值（非受控） */
  defaultChecked?: boolean;
  /** 变更回调 */
  onChange?: (checked: boolean) => void;
  /** 开关颜色：绿色（默认，iOS 标准）或蓝色 accent */
  color?: ToggleColor;
  /** 标签文字 */
  label?: React.ReactNode;
  /** 标签位置 */
  labelPlacement?: 'start' | 'end';
  /** 禁用 */
  disabled?: boolean;
  /** 紧凑小尺寸 */
  compact?: boolean;
  /** 自定义 id */
  id?: string;
  className?: string;
}

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  defaultChecked = false,
  onChange,
  color           = 'green',
  label,
  labelPlacement  = 'end',
  disabled        = false,
  compact         = false,
  id,
  className,
}) => {
  const autoId = useId();
  const inputId = id ?? autoId;

  /* 非受控内部状态 */
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const isChecked    = isControlled ? checked : internal;

  /* 按下拉伸动画状态 */
  const [pressed, setPressed] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isControlled) setInternal(e.target.checked);
    onChange?.(e.target.checked);
  };

  /* 轨道 class */
  const trackClass = [
    styles.track,
    isChecked && color === 'green'   ? styles.trackChecked : '',
    isChecked && color === 'accent'  ? styles.trackAccent  : '',
  ]
    .filter(Boolean)
    .join(' ');

  /* 滑块 class */
  const thumbClass = [
    styles.thumb,
    isChecked && !pressed            ? styles.thumbChecked       : '',
    pressed   && !isChecked          ? styles.thumbPressed        : '',
    pressed   && isChecked           ? styles.thumbPressedChecked : '',
  ]
    .filter(Boolean)
    .join(' ');

  const wrapperClass = [
    styles.wrapper,
    disabled     ? styles.wrapperDisabled : '',
    compact      ? styles.compact         : '',
    labelPlacement === 'start' ? 'flex-row-reverse' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label
      htmlFor={inputId}
      className={wrapperClass}
      style={labelPlacement === 'start' ? { flexDirection: 'row-reverse' } : undefined}
    >
      {/* 隐藏原生 checkbox */}
      <input
        type="checkbox"
        id={inputId}
        className={styles.input}
        checked={isChecked}
        onChange={handleChange}
        disabled={disabled}
        aria-checked={isChecked}
        role="switch"
      />

      {/* 轨道 + 滑块 */}
      <span
        className={trackClass}
        onPointerDown={() => !disabled && setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-hidden="true"
      >
        <span className={thumbClass} />
      </span>

      {/* 标签 */}
      {label && (
        <span className={styles.label}>{label}</span>
      )}
    </label>
  );
};

export default Toggle;
