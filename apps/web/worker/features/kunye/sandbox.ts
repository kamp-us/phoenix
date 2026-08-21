/**
 * The çaylak-sandbox policy seam (#1205) — where the authorship tier (künye) and
 * the moderation capability (ADR 0107) meet the content paths, kept out of the
 * sözlük/pano domain services so they stay vocabulary-free about authorship.
 *
 * Four helpers, all resolver-level:
 *   - {@link sandboxedAtForAuthor} — the create-time decision: should a new piece
 *     of content by this author land sandboxed? Decided by tier (çaylak ⇒ sandboxed,
 *     yazar ⇒ live).
 *   - {@link currentSandboxViewer} — the read-time viewer: the signed-in id, a
 *     non-throwing moderator probe of `Moderate.over(platform)`, and the flag-gated
 *     in-place opt-in (#6423), handed to the `SandboxVisibility` predicates. Resolved
 *     once per `POST /fate` request through {@link SandboxViewerMemo} (#6457).
 *   - {@link moderatorSandboxViewer} — the same viewer for an already-`Moderate`-gated
 *     read, taken off the discharged grant instead of re-probing for it (#6472).
 *   - {@link PublishDecision} / {@link decidePublish} / {@link alwaysLive} — the
 *     create-time live-broadcast gate, type-level: a node broadcast to a public
 *     fate-live topic requires a `PublishDecision`, constructible only from the
 *     sandbox state (gated) or the explicit always-Live restore hatch, so sandboxed
 *     content cannot leak to non-author/anonymous subscribers via the (viewer-blind)
 *     live topics — and a create path cannot *forget* the check (ADR 0107's
 *     make-the-mistake-untypeable, applied to the sandbox/fate-live boundary, #1280).
 *   - {@link viewerBlindUpdate} / {@link withoutInPlaceMarker} — the sibling gate for the
 *     UPDATE direction: `decidePublish` decides whether a node is broadcast at all, this
 *     decides what a broadcast node may carry (#6462).
 */

import {CurrentUser} from "@kampus/fate-effect";
import {Brand, Context, Effect} from "effect";
import {CaylakVisibility} from "../caylak-visibility/CaylakVisibility.ts";
import {caylakVisibilityOn} from "../caylak-visibility/gate.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Kunye} from "./Kunye.ts";
import {Moderate, moderatorOf, requireModeration} from "./moderate.ts";
import {sandboxesNewContent} from "./standing.ts";

export const sandboxedAtForAuthor = (
	authorId: string,
	now: Date,
): Effect.Effect<Date | null, never, Kunye> =>
	Effect.gen(function* () {
		const kunye = yield* Kunye;
		const tier = yield* kunye.tierOf(authorId);
		return sandboxesNewContent(tier) ? now : null;
	});

/**
 * Whether this account is the #6423 in-place viewer: a yazar who opted in to seeing
 * çaylak contributions in place. Four gates, cheapest first — anonymous, then the
 * `phoenix-caylak-visibility` flag, then the yazar floor, then the stored preference.
 *
 * The tier check is belt-and-braces against the write gate in #6422: a çaylak (or a
 * visitor) reads `false` even if a preference row somehow exists, so a demotion or a
 * bypassed mutation cannot leave a non-yazar holding the widened read.
 */
const inPlaceVisibility = Effect.fn("kunye.inPlaceVisibility")(function* (viewerId: string | null) {
	if (viewerId === null) return false;
	if (!(yield* caylakVisibilityOn)) return false;
	const kunye = yield* Kunye;
	if ((yield* kunye.tierOf(viewerId)) !== "yazar") return false;
	const caylakVisibility = yield* CaylakVisibility;
	return (yield* caylakVisibility.read(viewerId)).optedIn;
});

/**
 * Resolve the sandbox viewer for the current request: the signed-in account id
 * (null = anonymous), whether they hold platform-moderation authority, and whether
 * they are an opted-in in-place viewer (#6423). The moderator check is a non-throwing
 * probe — `Moderate.over(platform)` discharges to a `Grant` for a moderator and fails
 * `Denied` otherwise; we collapse that to a boolean so a non-moderator reads as
 * `canSeeSandboxed: false` rather than erroring the read.
 */
const resolveSandboxViewer = Effect.gen(function* () {
	const {user} = yield* CurrentUser;
	const viewerId = user?.id ?? null;
	// A non-throwing probe of the moderation gate: `requireModeration` discharges
	// `Moderate.over(platform)` and fails `Denied` for a non-moderator, which we
	// collapse to `false` rather than erroring the read.
	const canSeeSandboxed = yield* requireModeration(Effect.succeed(true)).pipe(
		Effect.catch(() => Effect.succeed(false)),
	);
	const seesSandboxedInPlace = yield* inPlaceVisibility(viewerId);
	return {viewerId, canSeeSandboxed, seesSandboxedInPlace} satisfies SandboxViewer;
});

export type SandboxViewerResolution = typeof resolveSandboxViewer;

/**
 * Where a request installs its one resolution, so the 26 call sites cost one probe + one
 * tier read + one opt-in read between them instead of three each (#6457). Shape and its
 * three load-bearing properties: `.patterns/fate-effect-worker-wiring.md`.
 *
 * The default MUST stay stateless — `Context.Reference` caches it on the key (Effect-TS/effect
 * `Context.ts`), so state here would be an isolate-level cache handing one viewer's tier
 * to another request.
 */
export const SandboxViewerMemo = Context.Reference<SandboxViewerResolution>(
	"kunye/SandboxViewerMemo",
	{defaultValue: () => resolveSandboxViewer},
);

/** One request's memo, for the `/fate` route edge to put on `requestServices`. */
export const makeSandboxViewerMemo: Effect.Effect<SandboxViewerResolution> =
	Effect.cached(resolveSandboxViewer);

/** @see {@link resolveSandboxViewer} — this reads it through the request's {@link SandboxViewerMemo}. */
export const currentSandboxViewer: SandboxViewerResolution = Effect.gen(function* () {
	return yield* yield* SandboxViewerMemo;
});

/**
 * The sandbox viewer a `Moderate`-gated read runs under (#6472). `Moderate` sits in R,
 * so this is unreachable without a discharged grant — the viewer that claims
 * `canSeeSandboxed` cannot be built by a path that never proved moderation authority.
 *
 * Distinct from {@link currentSandboxViewer}, which PROBES the moderation gate for an
 * ungated read and collapses a denial to `false`. Inside a gated path that probe is a
 * second relation-store round trip for an answer the grant already carries.
 *
 * `seesSandboxedInPlace` is `false` on purpose: that axis is the #6423 reader's opt-in to
 * seeing çaylak work inside the ordinary feed, and a moderation queue is not that feed.
 * It also never reaches the SQL, since `canSeeSandboxed` short-circuits
 * `sandboxVisibleWhere` — so leaving it `false` keeps the `sandboxedInPlace` wire marker
 * off the moderator's rows rather than mislabelling them.
 *
 * The `removed_at` dimension is untouched: the by-id reads carry their own
 * `isNull(removedAt)` guard, which takes no viewer, so a removed target stays out.
 */
export const moderatorSandboxViewer: Effect.Effect<SandboxViewer, never, Moderate> = Effect.gen(
	function* () {
		const grant = yield* Moderate;
		return {
			viewerId: yield* moderatorOf(grant),
			canSeeSandboxed: true,
			seesSandboxedInPlace: false,
		} satisfies SandboxViewer;
	},
);

/**
 * Whether a brand-new content node may be broadcast to a public (viewer-blind)
 * fate-live topic. Every node-broadcasting publish takes one, and it is constructible
 * ONLY from {@link decidePublish} or {@link alwaysLive} — so a create mutation cannot
 * broadcast without first discharging the sandbox check (#1280, ADR 0107's
 * make-the-mistake-untypeable). That rests on {@link makePublishDecision} staying
 * module-local.
 */
export type PublishDecision = Brand.Branded<{readonly broadcast: boolean}, "PublishDecision">;

// Kept PRIVATE: it is the only way to mint a `PublishDecision`, and `Brand.nominal`
// applies no runtime check (Effect-TS/effect `Brand.ts`) — it returns its input.
const makePublishDecision = Brand.nominal<PublishDecision>();
const branded = (broadcast: boolean): PublishDecision => makePublishDecision({broadcast});

/**
 * The fate-live fan-out is the leak surface (#1205): a node publish relays a full
 * payload to EVERY subscriber of a public topic, keyed by id and never by viewer
 * (ADRs 0023/0025/0037), so it bypasses the read paths' sandbox filters. Suppressing
 * the broadcast costs a sandboxed author their instant own-content echo — a deliberate
 * trade, since a viewer-blind topic cannot push to the author alone.
 */
export const decidePublish = (sandboxedAt: Date | null): PublishDecision =>
	branded(sandboxedAt === null);

/**
 * The escape hatch for content that is Live by construction — the `Removed → Live`
 * restore paths (ADR 0096 §4), which re-enter already-public content. Named + greppable
 * on purpose: a deliberate, reviewable opt-out, never something a create path falls into.
 */
export const alwaysLive: PublishDecision = branded(true);

/** The one place a `PublishDecision` is consumed — every feature's `live.ts` gates through it. */
export const broadcastIf = (
	decision: PublishDecision,
	publish: Effect.Effect<void>,
): Effect.Effect<void> => (decision.broadcast ? publish : Effect.void);

/**
 * Drop the reader-facing çaylak marker from an entity-update payload (#6462).
 *
 * `decidePublish` guards the NODE broadcasts, but an entity `live.update` carries the
 * whole re-resolved wire node and is ungated. `sandboxedInPlace` is resolved against the
 * MUTATOR's `SandboxViewer` (#6425), so an opted-in yazar's vote broadcasts `true` to
 * viewers holding no entitlement, and every other voter's `false` erases the badge a
 * subscriber correctly read. Both directions are the #4313 failure mode on the newer field.
 *
 * Omitting the key beats stamping `false`, because fate copies only the keys the payload
 * carries: an absent one leaves each subscriber's own read-derived value standing. The
 * owner-scoped `sandboxed` rides the same hazard and is deliberately left alone — #4313
 * owns that half.
 *
 * Since #6585 the publisher also trims the payload to the mutation's `changed` keys, which
 * drops the marker on every narrowed publish. This stays because it is the belt to that
 * brace: it covers the frames that carry no `changed`, where the whole node still rides.
 */
export const withoutInPlaceMarker = <T extends {readonly sandboxedInPlace?: boolean | undefined}>(
	node: T,
): Omit<T, "sandboxedInPlace"> => {
	const {sandboxedInPlace: _viewerDerived, ...viewerBlind} = node;
	return viewerBlind;
};

/**
 * The one consumer of {@link withoutInPlaceMarker}. A `data`-less update (a bare `changed`
 * signal) passes through untouched.
 *
 * A convention, NOT a type — unlike {@link PublishDecision}, which makes an ungated node
 * broadcast a compile error. It covers the entity classes that carry the marker: `panoLive`
 * (`Post`, `Comment`) and `sozlukLive` (`Definition`) route every `update` through it.
 * `pasaportLive` (`User`) and bildirim's `Notification` call `live.update` raw, which is
 * harmless because neither node has a `sandboxedInPlace` to leak — but nothing stops a
 * future `live.ts` publishing a `Post`/`Comment`/`Definition` update around this. Branding
 * the update payload the way `PublishDecision` brands the node broadcast is the fix that
 * would earn the stronger sentence; #6557 tracks it.
 */
export const viewerBlindUpdate = <
	T extends {readonly sandboxedInPlace?: boolean | undefined},
>(options?: {
	readonly changed?: ReadonlyArray<string>;
	readonly data?: T;
}): {readonly changed?: ReadonlyArray<string>; readonly data?: unknown} | undefined =>
	options?.data ? {...options, data: withoutInPlaceMarker(options.data)} : options;
