/* ============================================================
   src/components/ui/index.ts
   Apple HIG 设计系统 — 统一导出入口
   ============================================================ */

// Button
export { Button }                     from './Button/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button/Button';

// Input
export { Input }                      from './Input/Input';
export type { InputProps, InputVariant } from './Input/Input';

// Card
export { Card }                       from './Card/Card';
export type { CardProps, CardVariant } from './Card/Card';

// Modal / Sheet
export { Modal }                      from './Modal/Modal';
export type { ModalProps, ModalVariant } from './Modal/Modal';

// Navigation
export {
  TopBar,
  TopBarButton,
  BackButton,
  Sidebar,
  SidebarSectionTitle,
  SidebarDivider,
  NavItem,
}                                     from './Navigation/Navigation';
export type {
  TopBarProps,
  TopBarButtonProps,
  BackButtonProps,
  SidebarProps,
  NavItemProps,
}                                     from './Navigation/Navigation';

// Toggle / Switch
export { Toggle }                     from './Toggle/Toggle';
export type { ToggleProps, ToggleColor } from './Toggle/Toggle';

// Avatar
export { Avatar, AvatarGroup }        from './Avatar/Avatar';
export type {
  AvatarProps,
  AvatarGroupProps,
  AvatarSize,
  AvatarColor,
  AvatarStatus,
}                                     from './Avatar/Avatar';

// Badge / Label
export { Badge, BadgeWrapper, Label } from './Badge/Badge';
export type {
  BadgeProps,
  BadgeWrapperProps,
  LabelProps,
  BadgeColor,
  LabelColor,
  LabelVariant,
}                                     from './Badge/Badge';
