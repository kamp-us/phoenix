import {type Cmd, defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {DuplicateProgramId, ProgramNotFound} from "./errors.ts";
import {type AnyProgram, type Program, ProgramId, provenanceOf} from "./program.ts";
import {Registry} from "./Registry.ts";

type State = {readonly count: number};
type Msg = {readonly type: "tick"};

const counter = defineMachine<State, Msg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

const row = (id: string, version = "1.0.0"): AnyProgram =>
	({
		id: ProgramId.make(id),
		core: counter,
		ports: {
			ticks: {
				kind: "tick/v1",
				direction: "out",
				accepts: (p): p is number => typeof p === "number",
			},
		},
		handlers: {},
		capabilities: [{family: "filesystem", detail: "~/.tuval"}],
		identity: {package: "@kampus/tuval", program: id, version, digest: `sha256:${id}-${version}`},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, Cmd<never>, never, unknown, never, never>;

const withRegistry = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: (registry: Registry["Service"]) => Effect.Effect<A, E>,
) => Effect.runPromise(Effect.flatMap(Registry, body).pipe(Effect.provide(Registry.layer(rows))));

describe("Registry", () => {
	it("registers two distinct programs and resolves both", async () => {
		const [a, b] = [row("a"), row("b")];
		const resolved = await withRegistry([a, b], (registry) =>
			Effect.all(
				[
					registry.resolve(ProgramId.make("a")),
					registry.resolve(ProgramId.make("b")),
					registry.list,
				],
				{concurrency: "unbounded"},
			),
		);
		expect(resolved).toEqual([a, b, [a, b]]);
	});

	it("refuses a duplicate id at registration, naming the id and both rows' provenance", async () => {
		const [first, second] = [row("a", "1.0.0"), row("a", "2.0.0")];
		const error = await Effect.runPromise(
			Effect.flip(Effect.provide(Effect.succeed(undefined), Registry.layer([first, second]))),
		);
		expect(error).toBeInstanceOf(DuplicateProgramId);
		expect(error).toMatchObject({
			id: "a",
			first: provenanceOf(first),
			second: provenanceOf(second),
		});
		expect(error.message).toBe(
			'program id "a" is already registered by @kampus/tuval/a@1.0.0 (sha256:a-1.0.0); refusing @kampus/tuval/a@2.0.0 (sha256:a-2.0.0)',
		);
	});

	it("fails an unknown id with a typed error, never undefined", async () => {
		const error = await withRegistry([row("a")], (registry) =>
			Effect.flip(registry.resolve(ProgramId.make("missing"))),
		);
		expect(error).toBeInstanceOf(ProgramNotFound);
		expect(error.id).toBe("missing");
		expect(error.message).toBe('no program is registered under id "missing"');
	});
});
