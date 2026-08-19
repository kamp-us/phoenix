/**
 * The `Authorship` rights through the REAL `Capability.Level` seam — the denial paths
 * are the real discharge, not a re-implemented check. Standing is read off the real
 * {@link Kunye} service, the actor flows through {@link CurrentActor}, and the agent
 * arm routes the fail-closed {@link AgentAuthorityV1}.
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
import {AgentAuthorityV1} from "./AgentAuthorityV1.ts";
import {AddEntry, OpenTerm} from "./Authorship.ts";
import {RequiresLevel} from "./errors.ts";
import {makeKunyeStub} from "./Kunye.testing.ts";
import type {Kunye, Tier} from "./Kunye.ts";

const standings: Record<string, Tier> = {yzr: "yazar", cyl: "çaylak", vis: "visitor"};

const kunye = makeKunyeStub({tierOf: (id) => Effect.succeed(standings[id] ?? "visitor")});

const require = <Self>(
	gate: Effect.Effect<Grant<Self>, RequiresLevel, CurrentActor | AgentAuthority | Kunye>,
	actor: Actor,
): Exit.Exit<Grant<Self>, RequiresLevel> =>
	Effect.runSyncExit(
		gate.pipe(
			Effect.provide(Layer.mergeAll(Layer.succeed(CurrentActor, {actor}), AgentAuthorityV1, kunye)),
		),
	);

const denial = (exit: Exit.Exit<unknown, RequiresLevel>): RequiresLevel => {
	const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
	if (Option.isNone(failure)) throw new Error("expected a RequiresLevel denial, got a grant");
	return failure.value;
};

describe("OpenTerm — requires yazar", () => {
	it("a yazar clears the gate", () => {
		expect(Exit.isSuccess(require(OpenTerm.require, human("yzr")))).toBe(true);
	});

	it("a çaylak is denied (below the yazar floor)", () => {
		expect(Exit.isFailure(require(OpenTerm.require, human("cyl")))).toBe(true);
	});

	it("the anonymous actor is denied", () => {
		expect(Exit.isFailure(require(OpenTerm.require, unauthenticated))).toBe(true);
	});
});

describe("AddEntry — requires çaylak", () => {
	it("a çaylak clears the gate", () => {
		expect(Exit.isSuccess(require(AddEntry.require, human("cyl")))).toBe(true);
	});

	it("a yazar clears it too (ordered ladder — yazar gte çaylak)", () => {
		expect(Exit.isSuccess(require(AddEntry.require, human("yzr")))).toBe(true);
	});

	it("a visitor is denied (below the çaylak floor)", () => {
		expect(Exit.isFailure(require(AddEntry.require, human("vis")))).toBe(true);
	});

	it("the anonymous actor is denied", () => {
		expect(Exit.isFailure(require(AddEntry.require, unauthenticated))).toBe(true);
	});
});

describe("the denial is a RequiresLevel (FORBIDDEN) carrying the needed rank", () => {
	it("OpenTerm names yazar; AddEntry names çaylak", () => {
		const open = denial(require(OpenTerm.require, human("cyl")));
		expect(open).toBeInstanceOf(RequiresLevel);
		expect(open.need).toBe("yazar");
		expect(denial(require(AddEntry.require, human("vis"))).need).toBe("çaylak");
	});
});

describe("the agent arm routes the fail-closed v1 seam", () => {
	it("an agent is denied even when its human root is a yazar", () => {
		expect(Exit.isFailure(require(OpenTerm.require, agent("bot", "yzr")))).toBe(true);
		expect(Exit.isFailure(require(AddEntry.require, agent("bot", "yzr")))).toBe(true);
	});
});
