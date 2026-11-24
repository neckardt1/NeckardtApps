// Historical migration tests call the original JSON RPC before the typed RPC exists.
export function legacyAnswerRow(row, args) {
  if (row.kind !== "card") return row;
  return {
    kind: row.state === null ? "new_card" : "studied_card",
    review_id: args.p_review_id,
    card_id: args.p_card_id,
    revision: args.p_revision,
    due_at: row.due_at,
    scheduler_state: row.state
  };
}
