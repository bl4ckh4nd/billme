// Components
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './components/Button';
export { Badge, type BadgeProps, type BadgeStatus, type BadgeTone } from './components/Badge';
export { Input, type InputProps } from './components/Input';
export { Field, type FieldProps } from './components/Field';
export { Select, type SelectProps } from './components/Select';
export { Textarea, type TextareaProps } from './components/Textarea';
export { Card, type CardProps, type CardRadius, type CardElevation, type CardPadding } from './components/Card';
export { Amount, type AmountProps, type AmountSign } from './components/Amount';
export { EmptyState, type EmptyStateProps } from './components/EmptyState';
export { ErrorState, type ErrorStateProps } from './components/ErrorState';
export { BalanceIndicator, type BalanceIndicatorProps } from './components/BalanceIndicator';
export { HelpHint, type HelpHintProps } from './components/HelpHint';
export { Modal, type ModalProps } from './components/Modal';
export { Toast, type ToastAction, type ToastProps, type ToastVariant, type ToastSize } from './components/Toast';
export {
  FeedbackProvider,
  useActionFeedback,
  type ActionFeedback,
  type FeedbackAction,
  type FeedbackKind,
  type FeedbackOptions,
} from './components/FeedbackProvider';
export { Portal, type PortalProps } from './components/Portal';
export { ConfirmDialog, type ConfirmDialogProps } from './components/ConfirmDialog';
export { Combobox, type ComboboxProps } from './components/Combobox';
export { DatePicker, type DatePickerProps } from './components/DatePicker';
export {
  ValidationSummary,
  type ValidationSummaryIssue,
  type ValidationSummaryProps,
} from './components/ValidationSummary';

export {
  AuthScreen,
  describeAuthError,
  type AuthScreenCredentials,
  type AuthScreenMode,
  type AuthScreenProps,
} from './components/AuthScreen';
export { BillmeLogo } from './components/BillmeLogo';
export { IconButton, type IconButtonProps, type IconButtonVariant, type IconButtonSize } from './components/IconButton';
export { PageHeader, type PageHeaderProps } from './components/PageHeader';
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption, type SegmentedSize } from './components/SegmentedControl';
export { Checkbox, type CheckboxProps } from './components/Checkbox';
export { Switch, type SwitchProps } from './components/Switch';
export { Menu, type MenuItem, type MenuProps, type MenuTriggerProps } from './components/Menu';
export { Tooltip, type TooltipProps } from './components/Tooltip';
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  nextSort,
  type TableProps,
  type TableRowProps,
  type TableHeadProps,
  type TableCellProps,
  type TableDensity,
  type SortDirection,
} from './components/Table';
export { Kbd, type KbdProps } from './components/Kbd';
export { Avatar, initialsOf, type AvatarProps, type AvatarSize } from './components/Avatar';
export { Metric, type MetricProps, type MetricSize, type MetricTone } from './components/Metric';
export { Spinner, type SpinnerProps, type SpinnerSize } from './components/Spinner';
export { BarChart, niceMax, type BarChartProps, type BarDatum } from './components/BarChart';
export { Sparkline, type SparklineProps } from './components/Sparkline';

// Utils
export { cn } from './utils/cn';
export { useExitTransition, popoverExitClass, OVERLAY_EXIT_MS } from './utils/useExitTransition';
export { useAnchoredPosition, type AnchorAlign, type AnchoredStyle } from './utils/useAnchoredPosition';
export { EMPTY_VALUE, formatEmptyValue } from './utils/format';
export { colors, getStatusColors, getDunningColors, type ColorName } from './utils/colors';

// Re-export React types
export type { ReactNode } from 'react';
