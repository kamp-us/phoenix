/**
 * The çaylak-sandbox policy seam (#1205) — where the authorship tier (künye) and the
 * moderation capability (ADR 0107) meet the content paths, kept out of the sözlük/pano
 * domain services so they stay vocabulary-free about authorship.
 */

import {CurrentUser} from "@kampus/fate-effect";
import {Brand, Effect} from "effect";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Kunye} from "./Kunye.ts";
import {requireModeration} from "./moderate.ts";
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

export const currentSandboxViewer = Effect.gen(function* () {
	const {user} = yield* CurrentUser;
	// A non-throwing probe of the moderation gate: `requireModeration` fails `Denied` for
	// a non-moderator, collapsed to `false` here rather than erroring the whole read.
	const canSeeSandboxed = yield* requireModeration(Effect.succeed(true)).pipe(
		Effect.catch(() => Effect.succeed(false)),
	);
	return {viewerId: user?.id ?? null, canSeeSandboxed} satisfies SandboxViewer;
});

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
// applies no runtime check (effect-smol `Brand.ts`) — it returns its input.
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
