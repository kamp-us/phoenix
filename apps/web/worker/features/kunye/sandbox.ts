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
 *   - {@link PublishDecision} / {@link decidePublish} / {@link alwaysLive} — the
 *     create-time live-broadcast gate, type-level: a node broadcast to a public
 *     fate-live topic requires a `PublishDecision`, constructible only from the
 *     sandbox state (gated) or the explicit always-Live restore hatch, so sandboxed
 *     content cannot leak to non-author/anonymous subscribers via the (viewer-blind)
 *     live topics — and a create path cannot *forget* the check (ADR 0107's
 *     make-the-mistake-untypeable, applied to the sandbox/fate-live boundary, #1280).
 */

import {CurrentUser} from "@kampus/fate-effect";
import type {RuntimeContext} from "alchemy";
import {Brand, Effect} from "effect";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags, type RequestFlagOverrides} from "../flagship/FlagsContext.ts";
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
): Effect.Effect<
	Date | null,
	never,
	Kunye | Flags | RuntimeContext | CurrentUser | RequestFlagOverrides
> =>
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
 * Whether a brand-new content node may be broadcast to a public (viewer-blind)
 * fate-live topic. The type-level form of the #1205 gate: every node-broadcasting
 * publish (`appendNode` / `prependNode`, in each feature's `live.ts`) takes one, and
 * it is constructible ONLY from {@link decidePublish} (the sandbox-gated create path)
 * or {@link alwaysLive} (the explicit always-Live escape hatch). So a future create
 * mutation cannot broadcast a node without first discharging the sandbox check —
 * ADR 0107's make-the-mistake-untypeable, applied here (the #1280 hardening).
 *
 * Branded via effect-smol's standard `Brand` vocabulary (`Brand.Branded`, grounded
 * in effect-smol `Brand.ts`) — NOT a hand-rolled `unique symbol` phantom. The brand
 * is type-only: a `PublishDecision` is byte-identical to `{broadcast}` at runtime,
 * nominal only at the type level. Unconstructibility rests on the private
 * {@link makePublishDecision} constructor below staying module-local, so
 * {@link decidePublish} / {@link alwaysLive} remain the only exported constructors.
 */
export type PublishDecision = Brand.Branded<{readonly broadcast: boolean}, "PublishDecision">;

// `Brand.nominal` is the type-only constructor, kept PRIVATE so the module retains the
// only two exported ways to mint a `PublishDecision` (decidePublish / alwaysLive). It
// applies no runtime check (per effect-smol `Brand.ts`) — it returns its input.
const makePublishDecision = Brand.nominal<PublishDecision>();
const branded = (broadcast: boolean): PublishDecision => makePublishDecision({broadcast});

/**
 * The sandbox-gated decision a create path discharges: broadcast iff the new row is
 * live (`sandboxedAt === null`); a sandboxed row resolves to suppress.
 *
 * The fate-live fan-out is the leak surface (#1205 AC#2): a node publish relays a
 * full-payload frame to EVERY subscriber of a public topic — keyed only by
 * `{id: slug}` / `{id: postId}` / the global feed, never by viewer identity, with no
 * per-viewer re-resolution (ADRs 0023/0025/0037). The static read paths filter
 * sandboxed content (`sandboxVisibleWhere` / `isVisibleTo`), but the create-time
 * broadcast bypasses them, so a sandboxed çaylak's node would reach non-author
 * members and anonymous viewers. Routing every node broadcast through a
 * `PublishDecision` makes that unreachable by type.
 *
 * The author and moderators still see sandboxed content through the sandbox-aware
 * READ paths and the promotion-backlog queue (`listSandboxed*`); the live echo is an
 * optimization, not the source of truth. Suppressing it for sandboxed rows costs the
 * author an instant own-content echo (they see it on next read) — a deliberate
 * trade: the viewer-blind topic model can't deliver an author-only live push without
 * also leaking to others, and correctness outranks the echo. A viewer-keyed live
 * delivery is a deferred optimization, not in scope for #1205.
 */
export const decidePublish = (sandboxedAt: Date | null): PublishDecision =>
	branded(sandboxedAt === null);

/**
 * The always-Live escape hatch — a node broadcast that has no sandbox state to
 * discharge because it is Live by construction: the `Removed → Live` restore paths
 * (`EntityLifecycle.restore`, ADR 0096 §4), which re-enter already-public content.
 * Named + greppable on purpose: it is the deliberate, reviewable opt-out, not an
 * omission a create path can fall into (a create path has a `sandboxedAt` and must
 * route through {@link decidePublish}).
 */
export const alwaysLive: PublishDecision = branded(true);

/**
 * Run a node broadcast only when the decision permits it; suppress otherwise. The
 * `appendNode` / `prependNode` wrappers in each feature's `live.ts` gate every
 * create-time broadcast through this — the one place the decision is consumed.
 */
export const broadcastIf = (
	decision: PublishDecision,
	publish: Effect.Effect<void>,
): Effect.Effect<void> => (decision.broadcast ? publish : Effect.void);
