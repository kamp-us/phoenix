/**
 * The per-request {@link FlagsContext} resolution shared by `/api/flags/evaluate` and the
 * edge `window.__BOOT__` injection — the ONE override-authz seam both consume, so an admin
 * with an authorized `phoenix_flag_overrides` cookie gets IDENTICAL flag values from either
 * path (ADR 0179 AC2). One function makes the two consumers unable to drift.
 */
import type {CurrentUserInfo} from "@kampus/fate-effect";
import {Effect} from "effect";
import {currentActorContext} from "../kunye/CurrentActorLive.ts";
import {
	anonymousFlagsContext,
	type FlagsContextValue,
	makeRequestFlagsContext,
} from "./FlagsContext.ts";
import {overridesAuthorized} from "./override-authz.ts";

/**
 * `user` is typed to {@link CurrentUserInfo} — the structural subset
 * {@link currentActorContext} reads — so the real `Session` (a superset) is assignable and a
 * test can build one without a full session.
 */
export type FlagsSession = {readonly user: CurrentUserInfo} | null;

/** Derive the evaluation identity from the session — server-side only, never client-supplied. */
export const contextFromSession = (session: FlagsSession): FlagsContextValue =>
	session ? {userId: session.user.id} : anonymousFlagsContext;

/**
 * Discharges platform-admin authority against the caller's BASELINE (no-cookie) context,
 * then passes the verdict on — so an authorized admin's cookie is honored and any other
 * request's cookie stays inert.
 */
export const resolveRequestFlagsContext = (session: FlagsSession, cookieHeader: string | null) =>
	Effect.gen(function* () {
		const identity = contextFromSession(session);
		const baseline = yield* makeRequestFlagsContext(identity, null);
		const overridesAllowed = yield* overridesAuthorized(baseline).pipe(
			Effect.provide(currentActorContext(session?.user)),
		);
		return yield* makeRequestFlagsContext(identity, cookieHeader, overridesAllowed);
	});
