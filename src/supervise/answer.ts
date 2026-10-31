import { notifyPeer } from '../notify/bus.js';
import * as dao from '../storage/dao.js';

/**
 * Record a decision on an approval and wake the supervisor that can act on it.
 *
 * 🛑 ANSWERING THE ROW IS HALF THE JOB. A first cut of the web handler woke
 * the WEB USER's own handle, which wakes nobody who can act — the bodyless
 * wake guard is what surfaced it. The decision and the wake belong in one
 * place so they cannot drift apart.
 *
 * 🛑 THIS IS NOT AN AUTO-APPROVER. It records whatever decision it is given
 * and does not choose one. lee's ruling stands: manual is the default
 * permission mode, and nothing here decides on a human's behalf.
 */
export type AnswerOutcome =
  | { readonly kind: 'answered'; readonly approval: dao.Approval }
  | { readonly kind: 'already-answered'; readonly decision: 'approve' | 'deny' | null }
  | { readonly kind: 'no-such-approval' }
  | { readonly kind: 'ungrantable'; readonly message: string };

export function answerAndNotify(
  db: Parameters<typeof dao.getApproval>[0],
  id: number,
  decision: 'approve' | 'deny',
  fromHandle: string,
): AnswerOutcome {
  const request = dao.getApproval(db, id);

  if (!request) return { kind: 'no-such-approval' };

  let answered: boolean;

  try {
    answered = dao.answerApproval(db, id, decision);
  } catch (err) {
    // An unnamed request is a valid row that cannot be APPROVED, because
    // there is nothing to allowlist. Denying it always works.
    if (err instanceof dao.UnnameableApprovalError) {
      return { kind: 'ungrantable', message: err.message };
    }

    throw err;
  }

  if (!answered) {
    return { kind: 'already-answered', decision: dao.getApproval(db, id)?.decision ?? null };
  }

  // 🛑 THE SUPERVISOR'S HANDLE, AND THE DECISION RIDES IN THE BODY so it can
  // act without a database read. That is the whole reason envelopes carry one.
  notifyPeer(request.supervisorHandle, {
    id,
    to: request.supervisorHandle,
    from: fromHandle,
    ts: Date.now(),
    body: `approval ${id} ${decision}: ${request.requested ?? '(unnamed)'}`,
    approval: {
      approvalId: id,
      decision,
      requested: request.requested ?? '',
      grant: request.grant,
      grantForms: request.grantForms,
      sessionId: request.sessionId,
    },
  });

  return { kind: 'answered', approval: request };
}
