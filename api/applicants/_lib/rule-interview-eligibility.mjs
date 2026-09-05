import { interviewDecisionHold } from "./generation.mjs";

export const RULE_INTERVIEW_ALREADY_EMAILED = "already_emailed";

const SENT_ACK_STATUSES = new Set(["invited", "sendgrid_delivered"]);
const SENT_ROW_STATUSES = new Set(["emailed", "booked", "replied"]);

/**
 * Match the Applicants UI's ackFor contract. An ack belongs to the current
 * request when its requestId matches. With no decision, the ack is the durable
 * evidence itself, including historical/requestId-less send acknowledgements.
 */
export function currentApplicantAck(decision, ack) {
  if (!ack || typeof ack !== "object") return null;
  if (decision?.requestId && ack.requestId !== decision.requestId) return null;
  return ack;
}

/**
 * One reason contract for draft preview, Watching counters, and live Rules.
 * Pass decisions deliberately do not call this helper.
 */
export function ruleInterviewSkipReason(row, { decision = null, ack = null } = {}) {
  const hold = interviewDecisionHold(row);
  if (hold) return hold;

  const currentAck = currentApplicantAck(decision, ack);
  if (currentAck && SENT_ACK_STATUSES.has(String(currentAck.status || ""))) {
    return RULE_INTERVIEW_ALREADY_EMAILED;
  }
  if (SENT_ROW_STATUSES.has(String(row?.status || ""))) {
    return RULE_INTERVIEW_ALREADY_EMAILED;
  }
  if (row?.externalPriorSendAt || row?.external_prior_send_at) {
    return RULE_INTERVIEW_ALREADY_EMAILED;
  }
  return null;
}
