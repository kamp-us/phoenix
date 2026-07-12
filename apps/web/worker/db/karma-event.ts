/**
 * The karma-event **reason** — the closed set of events that move a user's
 * `total_karma`, recorded on every `karma_event` row so an earned balance is
 * reconstructable (issue #2592). Today Vote is the only karma writer, so the set
 * is a cast (`vote`) or its reversal (`retract`); a new karma source adds a member.
 *
 * Lives in `db/` — below both the `vote/` and `pasaport/` feature directories,
 * like {@link ./target-kind.ts} — because `schema.ts` sources the `karma_event.reason`
 * D1 enum from this tuple while `vote/Vote.ts` (the `KarmaBump` contract owner) types
 * its input against the same set. `schema.ts` can't import that vocabulary from
 * `vote/Vote.ts` (Vote imports `schema.ts`, so that edge is a cycle), so the one set
 * both need lives here, imported by both with no cycle.
 */
export const KARMA_EVENT_REASONS = ["vote", "retract"] as const;

export type KarmaEventReason = (typeof KARMA_EVENT_REASONS)[number];
