/**
 * `PublishMecmua` — the mecmua write-gate capability: a `Capability.Level` floored at
 * `yazar`, modeled verbatim on `OpenTerm`. The yazar floor is load-bearing and non-optional
 * — a çaylak CANNOT publish (ADR 0107 §7), and mecmua has NO çaylak sandbox, so this is the
 * whole publish authority. Draft-save is deliberately NOT gated by this floor: a private
 * draft write is normal-auth only.
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
 * Gate `body` behind the yazar floor, threading the grant into its R channel — so publishing
 * without a grant is a compile error (ADR 0107 §3).
 */
export const requirePublishMecmua = <A, E, R>(body: Effect.Effect<A, E, PublishMecmua | R>) =>
	PublishMecmua.require.pipe(Effect.flatMap((grant) => body.pipe(Grant.provide(grant))));
