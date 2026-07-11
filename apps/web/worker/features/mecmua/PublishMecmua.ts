/**
 * `PublishMecmua` — the mecmua write-gate capability (#2497, epic #2467, #2463).
 *
 * A `Capability.Level` floored at `yazar`, modeled verbatim on `OpenTerm`
 * (`features/kunye/Authorship.ts`): the tag IS the right, it reads the GLOBAL
 * account-level standing off {@link Kunye.tierOf} against the {@link authorshipLadder}
 * and denies with {@link RequiresLevel} (`FORBIDDEN`). The yazar floor is
 * load-bearing and non-optional — a çaylak CANNOT publish (ADR 0107 §7: one global
 * künye identity, earned authorship, not per-product). mecmua has NO çaylak sandbox
 * (yazar is above the sandbox), so this is the whole publish authority.
 *
 * {@link requirePublishMecmua} is the enforcement-by-R wrapper (ADR 0107 §3, the
 * divan `requireDivanAccess` idiom): it discharges the capability and threads the
 * minted grant into `body`'s R channel, so `body` reads `yield* PublishMecmua` for
 * the proof and "publishing without the gate" is a compile error, not a forgotten
 * `if`. Draft-save is deliberately NOT gated by this floor (a private draft write is
 * normal-auth only, #2497).
 */
import {Capability, Grant, type Principal} from "@kampus/authz";
import {Effect} from "effect";
import {RequiresLevel} from "../kunye/errors.ts";
import {authorshipLadder, Kunye} from "../kunye/Kunye.ts";

/** Read a principal's global account-level rank off the {@link Kunye} standing service. */
const standingOf = (principal: Principal) =>
	Effect.flatMap(Kunye, (kunye) => kunye.tierOf(principal.id));

/** Publish a mecmua yazı — requires `yazar` earned standing (the çaylak-refused floor). */
export class PublishMecmua extends Capability.Level<PublishMecmua>()("mecmua/PublishMecmua", {
	scale: authorshipLadder,
	min: "yazar",
	read: standingOf,
	deny: () => new RequiresLevel({message: "Yazı yayımlamak için yazar olmalısın.", need: "yazar"}),
}) {}

/**
 * Gate `body` behind {@link PublishMecmua}: discharge the yazar floor (denying a
 * çaylak/visitor/anonymous with the `FORBIDDEN` {@link RequiresLevel}) and thread the
 * resulting grant into `body`'s R channel via `Grant.provide`. So `body` reads
 * `yield* PublishMecmua` for the gate proof, and publishing without a grant is a
 * compile error (enforcement-by-R, ADR 0107 §3).
 */
export const requirePublishMecmua = <A, E, R>(body: Effect.Effect<A, E, PublishMecmua | R>) =>
	PublishMecmua.require.pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));
