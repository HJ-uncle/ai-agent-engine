import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modal.module.css';

/* ============================================================
   Modal — Apple HIG 风格模态弹窗 / 底部 Sheet
   支持：居中 Dialog / 底部 Sheet 两种布局
   支持：毛玻璃遮罩、弹性动画、Esc 关闭、点击遮罩关闭
   ============================================================ */

export type ModalVariant = 'dialog' | 'sheet';

export interface ModalProps {
  /** 是否显示 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 布局变体 */
  variant?: ModalVariant;
  /** 标题 */
  title?: React.ReactNode;
  /** 是否显示关闭按钮 */
  showClose?: boolean;
  /** Sheet 是否显示拖拽指示条 */
  showGrabber?: boolean;
  /** 点击遮罩是否关闭 */
  closeOnOverlay?: boolean;
  /** 底部操作区内容 */
  footer?: React.ReactNode;
  children?: React.ReactNode;
  /** 挂载目标（默认 document.body） */
  container?: Element | null;
}

/* SF Symbols 风格：关闭叉号 */
const XMarkIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
  </svg>
);

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  variant       = 'dialog',
  title,
  showClose     = true,
  showGrabber   = true,
  closeOnOverlay = true,
  footer,
  children,
  container,
}) => {
  const isSheet = variant === 'sheet';

  /* 动画状态：mounted 控制 DOM 存在；exiting 控制退出动画 */
  const [mounted, setMounted]   = useState(false);
  const [exiting, setExiting]   = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  /* 打开：挂载 DOM */
  useEffect(() => {
    if (open) {
      setExiting(false);
      setMounted(true);
    } else if (mounted) {
      /* 关闭：先播退出动画，再卸载 */
      setExiting(true);
      const t = setTimeout(() => {
        setMounted(false);
        setExiting(false);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]); // eslint-disable-line

  /* 锁定 body 滚动 */
  useEffect(() => {
    if (mounted) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mounted]);

  /* Esc 关闭 */
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mounted, onClose]);

  /* 焦点陷阱（简易版） */
  useEffect(() => {
    if (mounted) panelRef.current?.focus();
  }, [mounted]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnOverlay && e.target === e.currentTarget) onClose();
    },
    [closeOnOverlay, onClose]
  );

  if (!mounted) return null;

  const panelClass = [
    isSheet ? styles.sheet   : styles.dialog,
    exiting
      ? (isSheet ? styles.sheetExit   : styles.dialogExit)
      : (isSheet ? styles.sheetEnter  : styles.dialogEnter),
  ].join(' ');

  const overlayClass = [
    styles.overlay,
    isSheet ? styles.sheetOverlay : '',
    exiting ? styles.overlayExit  : styles.overlayEnter,
  ]
    .filter(Boolean)
    .join(' ');

  const node = (
    <div
      className={overlayClass}
      onClick={handleOverlayClick}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
      >
        {/* Sheet 拖拽指示条 */}
        {isSheet && showGrabber && <div className={styles.grabber} />}

        {/* 标题栏 */}
        {(title || showClose) && (
          <div className={styles.header}>
            {/* 左侧占位（居中标题需要） */}
            {showClose && <div style={{ width: 30 }} />}

            {title && (
              <h2 className={styles.modalTitle}>{title}</h2>
            )}

            {showClose && (
              <button
                type="button"
                className={styles.closeBtn}
                onClick={onClose}
                aria-label="关闭"
              >
                <XMarkIcon />
              </button>
            )}
          </div>
        )}

        {/* 内容区 */}
        {children && (
          <div className={styles.body}>{children}</div>
        )}

        {/* 底部操作区 */}
        {footer && (
          <div className={styles.footer}>{footer}</div>
        )}
      </div>
    </div>
  );

  return createPortal(node, container ?? document.body);
};

export default Modal;
