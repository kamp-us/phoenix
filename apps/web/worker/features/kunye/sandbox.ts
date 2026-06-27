/**
 * The çaylak-sandbox policy seam (#1205) — where the authorship tier (künye) and
 * the moderation capability (ADR 0107) meet the content paths, kept out of the
 * sözlük/pano domain services so they stay vocabulary-free about authorship.
 *
 * Three helpers, all resolver-level:
 *   - {@link sandboxedAtForAuthor} — the create-time decision: should a new piece
 *     of content by this author land sandboxed? Gated behind the #1204
 *     authorship-loop flag (default-off ⇒ today's behavior, zero regression), then
 *     by tier (çaylak ⇒ sandboxed, yazar ⇒ live).
 *   - {@link currentSandboxViewer} — the read-time viewer: the signed-in id plus a
 *     non-throwing moderator probe of `Moderate.over(platform)`, resolved once per
 *     read and handed to the `SandboxVisibility` predicates.
 *   - {@link publishIfLive} — the create-time live-broadcast gate: suppress the
 *     public fate-live fan-out for a sandboxed row, so sandboxed content never
 *     leaks to non-author/anonymous subscribers via the (viewer-blind) live topics.
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

/**
 * Gate a create-time live broadcast on the new content's sandbox state: run the
 * public `publish` only when the row is live (`sandboxedAt === null`); for a
 * sandboxed row, do nothing.
 *
 * The fate-live fan-out is the leak surface (#1205, AC#2): a `publish` here resolves
 * a full-payload node frame and relays it to EVERY subscriber of a public topic —
 * keyed only by `{id: slug}` / `{id: postId}` / the global feed, never by viewer
 * identity, with no per-viewer re-resolution (ADRs 0023/0025/0037). The static read
 * paths already filter sandboxed content (`sandboxVisibleWhere` / `isVisibleTo`), but
 * the create-time broadcast bypasses them, so a sandboxed çaylak's node would be
 * pushed live to non-author members and anonymous viewers. Routing every create-time
 * publish through this gate makes "broadcast a sandboxed node to a public topic"
 * structurally unreachable — a future create mutation reusing it cannot reintroduce
 * the leak.
 *
 * The author and moderators still see sandboxed content through the sandbox-aware
 * READ paths and the promotion-backlog queue (`listSandboxed*`); the live echo is an
 * optimization, not the source of truth. Suppressing it for sandboxed rows costs the
 * author an instant own-content echo (they see it on next read) — a deliberate
 * trade: the viewer-blind topic model can't deliver an author-only live push without
 * also leaking to others, and correctness outranks the echo. A viewer-keyed live
 * delivery is a deferred optimization, not in scope for #1205.
 */
export const publishIfLive = (
	sandboxedAt: Date | null,
	publish: Effect.Effect<void>,
): Effect.Effect<void> => (sandboxedAt === null ? publish : Effect.void);
