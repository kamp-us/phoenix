/**
 * Unit — the `PublishMecmua` write-gate through the real `Capability.Level` seam
 * (#2497, epic #2467, #2463). The load-bearing, non-optional guarantee: a **çaylak
 * is REFUSED publish** and a **yazar is allowed** — the earned-authorship floor (ADR
 * 0107 §7, one global künye identity). Standing is read off the real {@link Kunye}
 * service (a {@link makeKunyeStub} keyed by account id), the actor flows through
 * {@link CurrentActor}, and the agent arm routes the fail-closed
 * {@link AgentAuthorityV1}, so the denial path is the real discharge — not a
 * re-implemented check. A denied çaylak/visitor/anonymous fails {@link RequiresLevel}
 * (`FORBIDDEN`) carrying the needed `yazar` rank.
 */
import {
	type Actor,
	type AgentAuthority,
	agent,
	CurrentActor,
	type Grant,
	human,
	unauthenticated,
} from "@kampus/authz";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import {describe, expect, it} from "vitest";
import {AgentAuthorityV1} from "../kunye/AgentAuthorityV1.ts";
import {RequiresLevel} from "../kunye/errors.ts";
import {makeKunyeStub} from "../kunye/Kunye.testing.ts";
import type {Kunye, Tier} from "../kunye/Kunye.ts";
import {PublishMecmua} from "./PublishMecmua.ts";

/** Account id → earned rank, the standing the real `Kunye.tierOf` read resolves. */
const standings: Record<string, Tier> = {yzr: "yazar", cyl: "çaylak", vis: "visitor"};

const kunye = makeKunyeStub({tierOf: (id) => Effect.succeed(standings[id] ?? "visitor")});

/** Discharge `PublishMecmua` against an actor through all three real ports (one merged Layer). */
const require = (actor: Actor): Exit.Exit<Grant<PublishMecmua>, RequiresLevel> =>
	Effect.runSyncExit(
		PublishMecmua.require.pipe(
			Effect.provide(Layer.mergeAll(Layer.succeed(CurrentActor, {actor}), AgentAuthorityV1, kunye)),
		),
	);

/** The `RequiresLevel` a denied discharge failed with. */
const denial = (exit: Exit.Exit<unknown, RequiresLevel>): RequiresLevel => {
	const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
	if (Option.isNone(failure)) throw new Error("expected a RequiresLevel denial, got a grant");
	return failure.value;
};

describe("PublishMecmua — requires yazar (a çaylak CANNOT publish)", () => {
	it("a yazar clears the gate (allowed to publish)", () => {
		expect(Exit.isSuccess(require(human("yzr")))).toBe(true);
	});

	it("a çaylak is REFUSED publish (below the yazar floor)", () => {
		expect(Exit.isFailure(require(human("cyl")))).toBe(true);
	});

	it("a visitor is refused publish", () => {
		expect(Exit.isFailure(require(human("vis")))).toBe(true);
	});

	it("the anonymous actor is refused publish", () => {
		expect(Exit.isFailure(require(unauthenticated))).toBe(true);
	});
});

describe("the refusal is a RequiresLevel (FORBIDDEN) naming the needed rank", () => {
	it("a refused çaylak carries need = yazar", () => {
		const refused = denial(require(human("cyl")));
		expect(refused).toBeInstanceOf(RequiresLevel);
		expect(refused.need).toBe("yazar");
	});
});

describe("the agent arm routes the fail-closed v1 seam", () => {
	it("an agent is refused publish even when its human root is a yazar", () => {
		expect(Exit.isFailure(require(agent("bot", "yzr")))).toBe(true);
	});
});

// The declared R channel — parity with `Authorship.typetest.ts`'s discharge assertion:
// `.require` needs the ports + the standing read, never the proof it mints.
const _requiresTheThreePorts: Effect.Effect<
	Grant<PublishMecmua>,
	RequiresLevel,
	CurrentActor | AgentAuthority | Kunye
> = PublishMecmua.require;
void _requiresTheThreePorts;
