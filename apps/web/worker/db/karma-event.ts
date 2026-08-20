/**
 * The closed set of events that move a user's `total_karma`, recorded on every
 * `karma_event` row so an earned balance is reconstructable (#2592). A new karma
 * source adds a member.
 *
 * It lives in `db/`, below the feature directories, because both `schema.ts` and
 * `vote/Vote.ts` need it and `schema.ts` cannot import from `vote/Vote.ts` — Vote
 * already imports `schema.ts`, so that edge would be a cycle.
 */
export const KARMA_EVENT_REASONS = ["vote", "retract"] as const;

export type KarmaEventReason = (typeof KARMA_EVENT_REASONS)[number];
