/**
 * Unit — `AgentAuthorityV1` is fail-closed: `admits` denies every agent input,
 * so a capability discharged through the seam grants an agent nothing while a
 * human passes through unattenuated. The swap-without-editing-authz litmus is
 * asserted structurally — a program requiring the port is fully discharged by
 * this Layer alone (`Effect<…, never, never>`), so the port has exactly one
 * implementation point.
 */
import {
	type Actor,
	type Agent,
	AgentAuthority,
	agent,
	Capability,
	CurrentActor,
	human,
	Scale,
} from "@kampus/authz";
import {Effect, Exit} from "effect";
import {describe, expect, it} from "vitest";
import {AgentAuthorityV1} from "./AgentAuthorityV1.ts";

const admitsVia = (request: {readonly agent: Agent; readonly capability: string}): boolean =>
	Effect.runSync(
		Effect.gen(function* () {
			const authority = yield* AgentAuthority;
			return yield* authority.admits(request);
		}).pipe(Effect.provide(AgentAuthorityV1)),
	);

describe("AgentAuthorityV1 — fail-closed admits", () => {
	it("denies every agent input, regardless of agent, root, or capability", () => {
		expect(
			admitsVia({agent: {_tag: "Agent", id: "bot", root: "yzr"}, capability: "kunye/OpenTerm"}),
		).toBe(false);
		expect(admitsVia({agent: {_tag: "Agent", id: "x", root: "vis"}, capability: "anything"})).toBe(
			false,
		);
	});
});

class Denied {
	readonly _tag = "Denied" as const;
}

const ladder = Scale(["visitor", "çaylak", "yazar"]);

/** Standing fixture: account id → earned rank (the agent root "yzr" is a yazar). */
const standings: Record<string, "visitor" | "çaylak" | "yazar"> = {yzr: "yazar"};

/** A `Level` right floored at çaylak, discharged through the agent seam. */
class OpenTerm extends Capability.Level<OpenTerm>()("kunye/OpenTerm", {
	scale: ladder,
	min: "çaylak",
	read: (principal) => Effect.succeed(standings[principal.id] ?? "visitor"),
	deny: () => new Denied(),
}) {}

const requireWith = (actor: Actor): Exit.Exit<unknown, Denied> =>
	Effect.runSyncExit(
		OpenTerm.require.pipe(
			Effect.provideService(CurrentActor, {actor}),
			Effect.provide(AgentAuthorityV1),
		),
	);

describe("AgentAuthorityV1 — through the capability seam", () => {
	it("a human passes through unattenuated (own authority)", () => {
		expect(Exit.isSuccess(requireWith(human("yzr")))).toBe(true);
	});

	it("an agent is denied even when its human root clears the floor", () => {
		// root "yzr" is a yazar → clears the çaylak floor; only the fail-closed seam denies it.
		expect(Exit.isFailure(requireWith(agent("bot", "yzr")))).toBe(true);
	});

	it("is the port's sole fill — discharges AgentAuthority with no edit to packages/authz", () => {
		const bot: Agent = {_tag: "Agent", id: "x", root: "r"};
		const needsPort: Effect.Effect<boolean, never, AgentAuthority> = Effect.gen(function* () {
			const authority = yield* AgentAuthority;
			return yield* authority.admits({agent: bot, capability: "c"});
		});
		// Providing only this Layer leaves R = never: v1.1 swaps the fill, never authz.
		const runnable: Effect.Effect<boolean, never, never> = needsPort.pipe(
			Effect.provide(AgentAuthorityV1),
		);
		expect(Effect.runSync(runnable)).toBe(false);
	});
});
