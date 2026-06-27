/**
 * Unit — the class-as-capability builders end to end: the exhaustive Actor
 * dispatch of each discharge verb, `Level` ordering through `.require`,
 * `Relation` ancestry through `.over`, the dormant `AgentAuthority` seam
 * (fail-closed), and `Grant` provision into the context channel via `.provide`.
 */
import {Effect, Exit} from "effect";
import {describe, expect, it} from "vitest";
import {type Actor, agent, human, unauthenticated} from "./Actor.ts";
import {AgentAuthority} from "./AgentAuthority.ts";
import {Capability} from "./Capability.ts";
import {CurrentActor} from "./CurrentActor.ts";
import {isGrant} from "./Grant.ts";
import {Scale} from "./Level.ts";
import {RelationStore} from "./Relation.ts";
import {resource} from "./Resource.ts";

class Denied {
	readonly _tag = "Denied" as const;
}

const ladder = Scale(["visitor", "çaylak", "yazar"]);

/** Standing fixture: account id → earned rank. */
const standings: Record<string, "visitor" | "çaylak" | "yazar"> = {
	yzr: "yazar",
	cyl: "çaylak",
	vis: "visitor",
};

/** A `Level` capability floored at çaylak. */
class AddEntry extends Capability.Level<AddEntry>()("test/AddEntry", {
	scale: ladder,
	min: "çaylak",
	read: (principal) => Effect.succeed(standings[principal.id] ?? "visitor"),
	deny: () => new Denied(),
}) {}

/** A `Relation` capability over the `moderates` verb. */
class Moderate extends Capability.Relation<Moderate>()("test/Moderate", {
	relation: "moderates",
	deny: () => new Denied(),
}) {}

const platform = resource("platform", "kampus");
const term = resource("term", "42", platform);

type Tuple = {readonly subject: string; readonly type: string; readonly id: string};

interface Env {
	readonly actor: Actor;
	readonly admit?: boolean;
	readonly tuples?: ReadonlyArray<Tuple>;
}

/** Provide the three ports off a fixture and run to an `Exit`. */
const run = <A, E>(
	program: Effect.Effect<A, E, CurrentActor | AgentAuthority | RelationStore>,
	env: Env,
): Exit.Exit<A, E> =>
	Effect.runSyncExit(
		program.pipe(
			Effect.provideService(CurrentActor, {actor: env.actor}),
			Effect.provideService(AgentAuthority, {
				admits: () => Effect.succeed(env.admit ?? false),
			}),
			Effect.provideService(RelationStore, {
				has: (tuple) =>
					Effect.succeed(
						(env.tuples ?? []).some(
							(t) =>
								t.subject === tuple.subject &&
								t.type === tuple.object.type &&
								t.id === tuple.object.id,
						),
					),
			}),
		),
	);

const grantOf = <A, E>(exit: Exit.Exit<A, E>): A => {
	if (!Exit.isSuccess(exit)) throw new Error("expected a granted proof, got a denial");
	return exit.value;
};

const isDenied = <A>(exit: Exit.Exit<A, Denied>): boolean => Exit.isFailure(exit);

describe("Capability.Level — .require", () => {
	it("mints for a human at the floor and stamps the actor + level", () => {
		const grant = grantOf(run(AddEntry.require, {actor: human("cyl")}));
		expect(isGrant(grant)).toBe(true);
		expect(grant.scope.capability).toBe("test/AddEntry");
		expect(grant.scope.level).toBe("çaylak");
		expect(grant.actor).toEqual(human("cyl"));
	});

	it("mints for a human above the floor (yazar clears a çaylak gate)", () => {
		expect(Exit.isSuccess(run(AddEntry.require, {actor: human("yzr")}))).toBe(true);
	});

	it("denies a human below the floor", () => {
		expect(isDenied(run(AddEntry.require, {actor: human("vis")}))).toBe(true);
	});

	it("denies the anonymous actor", () => {
		expect(isDenied(run(AddEntry.require, {actor: unauthenticated}))).toBe(true);
	});

	it("agent passes only when its root clears the floor AND AgentAuthority admits", () => {
		// root is yazar, attenuation admitted → granted
		expect(Exit.isSuccess(run(AddEntry.require, {actor: agent("bot", "yzr"), admit: true}))).toBe(
			true,
		);
		// root clears the floor but the v1 fail-closed seam denies → denied
		expect(isDenied(run(AddEntry.require, {actor: agent("bot", "yzr"), admit: false}))).toBe(true);
		// attenuation admitted but the root itself is below the floor → denied
		expect(isDenied(run(AddEntry.require, {actor: agent("bot", "vis"), admit: true}))).toBe(true);
	});
});

describe("Capability.Relation — .over", () => {
	const onPlatform: ReadonlyArray<Tuple> = [{subject: "mod", type: "platform", id: "kampus"}];

	it("mints when the human holds the relation on an ancestor (covers descendants)", () => {
		const grant = grantOf(run(Moderate.over(term), {actor: human("mod"), tuples: onPlatform}));
		expect(grant.scope.capability).toBe("test/Moderate");
		expect(grant.scope.resource).toEqual(term);
	});

	it("denies when no tuple covers the resource (invisible denial, fresh read)", () => {
		expect(isDenied(run(Moderate.over(term), {actor: human("rando"), tuples: onPlatform}))).toBe(
			true,
		);
		// no tuples at all → denied (a revoked tuple denies the next call)
		expect(isDenied(run(Moderate.over(term), {actor: human("mod"), tuples: []}))).toBe(true);
	});

	it("denies the anonymous actor", () => {
		expect(isDenied(run(Moderate.over(term), {actor: unauthenticated, tuples: onPlatform}))).toBe(
			true,
		);
	});

	it("agent passes only when its root holds the relation AND AgentAuthority admits", () => {
		const rootMod: ReadonlyArray<Tuple> = [{subject: "human-root", type: "platform", id: "kampus"}];
		expect(
			Exit.isSuccess(
				run(Moderate.over(term), {actor: agent("bot", "human-root"), admit: true, tuples: rootMod}),
			),
		).toBe(true);
		expect(
			isDenied(
				run(Moderate.over(term), {
					actor: agent("bot", "human-root"),
					admit: false,
					tuples: rootMod,
				}),
			),
		).toBe(true);
	});
});

describe("Capability.Class — .authorize", () => {
	class Special extends Capability.Class<Special>()("test/Special", {
		deny: () => new Denied(),
	}) {}

	it("mints when the caller's check passes, denies when it fails", () => {
		const ok = run(
			Special.authorize(Effect.succeed(true)).pipe(Effect.map((g) => g.scope.capability)),
			{actor: human("anyone")},
		);
		expect(grantOf(ok)).toBe("test/Special");
		expect(isDenied(run(Special.authorize(Effect.succeed(false)), {actor: human("anyone")}))).toBe(
			true,
		);
	});
});

describe("Grant provision into context — .provide", () => {
	// An op that declares the proof in its R channel and reads it back.
	const op: Effect.Effect<string, never, AddEntry> = Effect.gen(function* () {
		const proof = yield* AddEntry;
		return proof.scope.capability;
	});

	it("discharges the requirement: the provided proof flows through R", () => {
		const grant = grantOf(run(AddEntry.require, {actor: human("yzr")}));
		// after `.provide(grant)` the op needs nothing — R is `never`, runnable.
		const discharged: Effect.Effect<string, never, never> = op.pipe(AddEntry.provide(grant));
		expect(Effect.runSync(discharged)).toBe("test/AddEntry");
	});
});
