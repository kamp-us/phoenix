/**
 * The funnel-readout access gate — enforcement-by-R (ADR 0107 §3), so a funnel read
 * that forgets the gate is a compile error, not a forgotten `if`.
 *
 * Its own capability rather than a reuse of `ViewDivan`: the funnel is mod-only, the
 * divan is yazar-OR-mod. Denial is the invisible {@link Denied}, so a non-mod read
 * cannot distinguish "not a moderator" from "not signed in".
 */
import {Capability, Grant, platform} from "@kampus/authz";
import {Effect} from "effect";
import {Denied} from "../kunye/errors.ts";
import {Moderate} from "../kunye/moderate.ts";

/**
 * Named rather than inlined so a later founder arm — if founders ever diverge from
 * the `moderates` tuple — OR-s in here without touching the callers.
 */
const standsInFunnel = Moderate.over(platform).pipe(
	Effect.as(true),
	Effect.catch(() => Effect.succeed(false)),
);

export class ViewFunnel extends Capability.Class<ViewFunnel>()("funnel/ViewFunnel", {
	deny: () => new Denied({message: "Dönüşüm metriklerini görmek için moderatör olmalısın."}),
}) {}

export const requireFunnelAccess = <A, E, R>(body: Effect.Effect<A, E, ViewFunnel | R>) =>
	ViewFunnel.authorize(standsInFunnel).pipe(
		Effect.flatMap((grant) => body.pipe(Grant.provide(grant))),
	);
