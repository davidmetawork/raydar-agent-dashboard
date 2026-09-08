-- A role the candidate stayed silent about in a reply that accepted other
-- roles from the same exact producer offer is decided deterministically,
-- outside the model, and must never carry an invented candidate quote.
-- The grounding requirement is not relaxed: a decisive decision still needs a
-- verbatim quote unless it carries this exact quote-free evidence kind, which
-- only the omission pre-pass writes.
alter table submissions_v2.signal_role_decisions
  add column evidence_kind text
    check (evidence_kind is null or evidence_kind = 'omission_prepass_v1');

alter table submissions_v2.signal_role_decisions
  drop constraint signal_role_decisions_check,
  add constraint signal_role_decisions_grounded_check check (
    decision_label = 'needs_review'
    or length(btrim(coalesce(exact_quote, ''))) > 0
    or (evidence_kind = 'omission_prepass_v1'
      and decision_label = 'not_interested'
      and exact_quote is null)
  );
