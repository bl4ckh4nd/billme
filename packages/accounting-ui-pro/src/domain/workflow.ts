import {
  ActivityEvent,
  BookingAction,
  BookingDraft,
  BookingWorkflowStatus,
  UiPermissionContext,
  ValidationIssue,
} from '../types';
import { hasBlockingIssues } from './validation';

export function getAllowedActions(
  status: BookingWorkflowStatus,
  permissionCtx: UiPermissionContext,
  validationIssues: ValidationIssue[],
): BookingAction[] {
  const blocking = hasBlockingIssues(validationIssues);
  const actions: BookingAction[] = permissionCtx.canMutate ? ['save_draft'] : [];

  if (permissionCtx.canMutate && (status === 'incomplete' || status === 'suggested' || status === 'ready_for_review')) {
    actions.push('submit_for_review');
  }

  if (status === 'pending_approval' && permissionCtx.canApprove) {
    actions.push('approve', 'reject');
  }

  if (status === 'approved' && permissionCtx.canPost && !blocking) {
    actions.push('post');
  }

  if (status === 'posted' && permissionCtx.canReverse) {
    actions.push('reverse', 'create_correction');
  }

  if (permissionCtx.canMutate && status !== 'posted' && status !== 'reversed') {
    actions.push('request_receipt');
  }

  return Array.from(new Set(actions));
}

export interface TransitionContext {
  actorId: string;
  actorName: string;
  approvalRequired: boolean;
  validationIssues: ValidationIssue[];
  rejectReason?: string;
}

export function canTransition(
  draft: BookingDraft,
  action: BookingAction,
  permissionCtx: UiPermissionContext,
  validationIssues: ValidationIssue[],
): boolean {
  if (!permissionCtx.canMutate) return false;
  const blocking = hasBlockingIssues(validationIssues);
  const status = draft.workflowStatus;

  switch (action) {
    case 'save_draft':
    case 'request_receipt':
      return status !== 'posted' && status !== 'reversed';
    case 'submit_for_review':
      return ['incomplete', 'suggested', 'ready_for_review'].includes(status) && !blocking;
    case 'approve':
      return status === 'pending_approval' && permissionCtx.canApprove;
    case 'reject':
      return status === 'pending_approval' && permissionCtx.canApprove;
    case 'post':
      return status === 'approved' && permissionCtx.canPost && !blocking;
    case 'reverse':
      return status === 'posted' && permissionCtx.canReverse;
    case 'create_correction':
      return status === 'posted' && permissionCtx.canReverse;
    default:
      return false;
  }
}

function createEvent(
  type: ActivityEvent['type'],
  label: string,
  actorId: string,
  actorName: string,
  details?: string,
): ActivityEvent {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    actorId,
    actorName,
    type,
    label,
    details,
  };
}

function nextStatusForSubmit(ctx: TransitionContext): BookingWorkflowStatus {
  return ctx.approvalRequired ? 'pending_approval' : 'approved';
}

export function transitionBooking(
  draft: BookingDraft,
  action: BookingAction,
  ctx: TransitionContext,
): BookingDraft {
  const next = structuredClone(draft) as BookingDraft;
  next.validationIssues = ctx.validationIssues;

  switch (action) {
    case 'save_draft':
      next.activity.unshift(createEvent('field_changed', 'Entwurf gespeichert', ctx.actorId, ctx.actorName));
      return next;
    case 'submit_for_review': {
      const previous = next.workflowStatus;
      next.workflowStatus = nextStatusForSubmit(ctx);
      next.approval.status = ctx.approvalRequired ? 'pending' : 'not_required';
      next.activity.unshift(
        createEvent(
          'state_changed',
          `Status geändert: ${previous} -> ${next.workflowStatus}`,
          ctx.actorId,
          ctx.actorName,
        ),
      );
      return next;
    }
    case 'approve': {
      const previous = next.workflowStatus;
      next.workflowStatus = 'approved';
      next.approval.status = 'approved';
      next.approval.reviewerId = ctx.actorId;
      next.approval.reviewerName = ctx.actorName;
      next.approval.reviewedAt = new Date().toISOString();
      next.activity.unshift(
        createEvent('state_changed', `Status geändert: ${previous} -> approved`, ctx.actorId, ctx.actorName),
      );
      return next;
    }
    case 'reject': {
      const previous = next.workflowStatus;
      next.workflowStatus = 'incomplete';
      next.approval.status = 'rejected';
      next.approval.reason = ctx.rejectReason ?? 'Zur Korrektur zurückgegeben';
      next.activity.unshift(
        createEvent(
          'state_changed',
          `Status geändert: ${previous} -> incomplete`,
          ctx.actorId,
          ctx.actorName,
          next.approval.reason,
        ),
      );
      return next;
    }
    case 'post': {
      const previous = next.workflowStatus;
      next.workflowStatus = 'posted';
      next.activity.unshift(createEvent('booking_posted', 'Buchung gebucht', ctx.actorId, ctx.actorName));
      next.activity.unshift(
        createEvent('state_changed', `Status geändert: ${previous} -> posted`, ctx.actorId, ctx.actorName),
      );
      return next;
    }
    case 'reverse': {
      const previous = next.workflowStatus;
      next.workflowStatus = 'reversed';
      next.activity.unshift(createEvent('booking_reversed', 'Buchung storniert', ctx.actorId, ctx.actorName));
      next.activity.unshift(
        createEvent('state_changed', `Status geändert: ${previous} -> reversed`, ctx.actorId, ctx.actorName),
      );
      return next;
    }
    case 'create_correction': {
      const previous = next.workflowStatus;
      next.workflowStatus = 'corrected';
      next.activity.unshift(
        createEvent('state_changed', `Status geändert: ${previous} -> corrected`, ctx.actorId, ctx.actorName),
      );
      return next;
    }
    case 'request_receipt':
      next.activity.unshift(createEvent('comment_added', 'Beleg angefordert', ctx.actorId, ctx.actorName));
      return next;
    default:
      return next;
  }
}
