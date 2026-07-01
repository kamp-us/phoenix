/**
 * The funnel-readout access gate (#1589) — the founder/mod destination gate for
 * the aggregate conversion metrics, built on the divan gate seam (`divan/gate.ts`):
 * a `ViewFunnel` `Capability.Class` whose `.authorize(check)` mints ONE
 * `Grant<ViewFunnel>` the read requires in its R channel (enforcement-by-R, ADR
 * 0107 §3), so a funnel read that forgets the gate is a compile error, not a
 * forgotten `if`.
 *
 * The check {@link standsInFunnel} discharges `Moderate.over(platform)` — the ReBAC
 * `moderates` relation over the platform scope (the same tuple founders are seeded
 * with, so "founder/mod" is the one `moderates`-platform holder, not a second axis)
 * — collapsed to a boolean, mirroring the divan gate's mod arm. Aggregate platform
 * metrics are a private founder/mod destination, so the gate lives here as its own
 * capability rather than reusing `ViewDivan` (whose disjunction admits any yazar):
 * the funnel is mod-only, the divan is yazar-OR-mod.
 *
 * Denial is the invisible {@link Denied} (`UNAUTHORIZED`): a non-mod / signed-out
 * read cannot distinguish "not a moderator" from "not signed in" — exactly the
 * divan/moderation-queue destination shape.
 */
import {Capability, Grant, platform} from "@kampus/authz";
import {Effect} from "effect";
import {Denied} from "../kunye/errors.ts";
import {Moderate} from "../kunye/moderate.ts";

/**
 * TRUE iff the current actor holds `Moderate.over(platform)`. The single arm of the
 * funnel gate: a real capability discharge whose denial (`Denied`) is collapsed to
 * `false` — the collapse-to-allow shape, kept as a named check so a later founder
 * arm (if founders ever diverge from the `moderates` tuple) OR-s in here without
 * touching the callers.
 */
const standsInFunnel = Moderate.over(platform).pipe(
	Effect.as(true),
	Effect.catch(() => Effect.succeed(false)),
);

/**
 * The funnel-view right, discharged by platform-moderation authority (see module
 * docblock). A generic `Capability.Class` so the gate carries its own tag/right
 * distinct from `ViewDivan` — the funnel is a mod-only destination, not the divan's
 * yazar-OR-mod one.
 */
export class ViewFunnel extends Capability.Class<ViewFunnel>()("funnel/ViewFunnel", {
	deny: () => new Denied({message: "Dönüşüm metriklerini görmek için moderatör olmalısın."}),
}) {}

/**
 * Gate `body` behind funnel access: discharge {@link ViewFunnel} (the invisible
 * {@link Denied} on failure) and thread the resulting grant into `body`'s R channel
 * via `Grant.provide`. So `body` reads `yield* ViewFunnel` for the gate proof, and
 * "reading the funnel without a grant" is a compile error — the same shape as
 * `requireDivanAccess`, here over the mod-only capability.
 */
export const requireFunnelAccess = <A, E, R>(body: Effect.Effect<A, E, ViewFunnel | R>) =>
	ViewFunnel.authorize(standsInFunnel).pipe(
		Effect.flatMap((grant) => body.pipe(Grant.provide(grant))),
	);
