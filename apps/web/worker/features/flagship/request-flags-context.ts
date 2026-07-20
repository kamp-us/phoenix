/**
 * The per-request {@link FlagsContext} resolution shared by `/api/flags/evaluate`
 * (`route.ts`) and the edge `window.__BOOT__` injection (`shell-boot-route.ts`) — the
 * ONE override-authz seam (#2741) both consume, so an admin with an authorized
 * `phoenix_flag_overrides` cookie gets IDENTICAL
 * flag values from the API and in `__BOOT__` (ADR 0179 AC2; the #2984 parity fix). A single
 * function makes the two consumers structurally unable to drift on the third
 * `makeRequestFlagsContext` override-authz arg (the divergence #2984 caught).
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
 * The session shape both routes carry from `pasaport.validateSession`. `user` is typed to
 * {@link CurrentUserInfo} — the structural subset {@link currentActorContext} reads — so the
 * real `Session` (a superset) is assignable and a test can build one without a full session.
 */
export type FlagsSession = {readonly user: CurrentUserInfo} | null;

/** Derive the evaluation identity from the session — server-side only, never client-supplied. */
export const contextFromSession = (session: FlagsSession): FlagsContextValue =>
	session ? {userId: session.user.id} : anonymousFlagsContext;

/**
 * Resolve the per-request context WITH the #2741 override-authz verdict: discharge
 * platform-admin authority from the session actor against the caller's BASELINE (no-cookie)
 * context, then
 * pass the verdict as the third `makeRequestFlagsContext` arg — so an authorized admin's
 * `phoenix_flag_overrides` cookie is honored and any other request's cookie stays inert.
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
