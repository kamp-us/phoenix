/**
 * The çaylak-sandbox policy seam (#1205) — where the authorship tier (künye) and
 * the moderation capability (ADR 0107) meet the content paths, kept out of the
 * sözlük/pano domain services so they stay vocabulary-free about authorship.
 *
 * Two helpers, both resolver-level:
 *   - {@link sandboxedAtForAuthor} — the create-time decision: should a new piece
 *     of content by this author land sandboxed? Gated behind the #1204
 *     authorship-loop flag (default-off ⇒ today's behavior, zero regression), then
 *     by tier (çaylak ⇒ sandboxed, yazar ⇒ live).
 *   - {@link currentSandboxViewer} — the read-time viewer: the signed-in id plus a
 *     non-throwing moderator probe of `Moderate.over(platform)`, resolved once per
 *     read and handed to the `SandboxVisibility` predicates.
 */

import {CurrentUser} from "@kampus/fate-effect";
import type {RuntimeContext} from "alchemy";
import {Effect} from "effect";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Kunye} from "./Kunye.ts";
import {requireModeration} from "./moderate.ts";

/**
 * The `sandboxed_at` timestamp a new piece of content by `authorId` is created
 * with, or `null` to create it live. Sandboxed only when the authorship-loop flag
 * is ON (safe-default off — a Flagship outage or the unflipped default both read
 * `false`, so content is live exactly as today) AND the author is a `çaylak`. A
 * yazar's content is always live.
 */
export const sandboxedAtForAuthor = (
	authorId: string,
	now: Date,
): Effect.Effect<Date | null, never, Kunye | Flags | RuntimeContext | CurrentUser> =>
	Effect.gen(function* () {
		const flags = yield* Flags;
		const loopOn = yield* flags
			.getBoolean(PHOENIX_AUTHORSHIP_LOOP, false)
			.pipe(provideRequestFlags);
		if (!loopOn) return null;
		const kunye = yield* Kunye;
		const tier = yield* kunye.tierOf(authorId);
		return tier === "çaylak" ? now : null;
	});

/**
 * Resolve the sandbox viewer for the current request: the signed-in account id
 * (null = anonymous) plus whether they hold platform-moderation authority. The
 * moderator check is a non-throwing probe — `Moderate.over(platform)` discharges
 * to a `Grant` for a moderator and fails `Denied` otherwise; we collapse that to a
 * boolean so a non-moderator reads as `canSeeSandboxed: false` rather than erroring
 * the read.
 */
export const currentSandboxViewer = Effect.gen(function* () {
	const {user} = yield* CurrentUser;
	// A non-throwing probe of the moderation gate: `requireModeration` discharges
	// `Moderate.over(platform)` and fails `Denied` for a non-moderator, which we
	// collapse to `false` rather than erroring the read.
	const canSeeSandboxed = yield* requireModeration(Effect.succeed(true)).pipe(
		Effect.catch(() => Effect.succeed(false)),
	);
	return {viewerId: user?.id ?? null, canSeeSandboxed} satisfies SandboxViewer;
});
