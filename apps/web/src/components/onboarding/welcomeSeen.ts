/**
 * The shown-once welcome marker (#7043, epic #4304).
 *
 * One persisted per-account fact — "this account has already been welcomed" — that both
 * the post-auth intercept in `App.tsx` and `WelcomePage` itself read. Surviving reloads
 * *and* repeat logins is what "once per account" (#4266) means here. The keying,
 * storage handle and failure behaviour are `perUserMarker.ts`'s, shared with #7044's
 * nudge dismissal.
 */
import {type MarkerStorage, markerKey, markerStorage, perUserMarker} from "./perUserMarker";

/** Bumped to force every persisted marker stale. */
export const WELCOME_SEEN_SCHEMA = "v1";

const WELCOME_SEEN_NAME = "welcome-seen";

const marker = perUserMarker(WELCOME_SEEN_NAME, WELCOME_SEEN_SCHEMA);

export type WelcomeStorage = MarkerStorage;

export function welcomeSeenKey(schema: string, userId: string): string {
	return markerKey(WELCOME_SEEN_NAME, schema, userId);
}

export const hasSeenWelcome = marker.isSet;
export const markWelcomeSeen = marker.set;
export const welcomeStorage = markerStorage;
