import {type Cmd, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
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
) => Effect.flatMap(Registry, body).pipe(Effect.provide(Registry.layer(rows)));

describe("Registry", () => {
	it.effect("registers two distinct programs and resolves both", () =>
		Effect.gen(function* () {
			const [a, b] = [row("a"), row("b")];
			const resolved = yield* withRegistry([a, b], (registry) =>
				Effect.all(
					[
						registry.resolve(ProgramId.make("a")),
						registry.resolve(ProgramId.make("b")),
						registry.list,
					],
					{concurrency: "unbounded"},
				),
			);
			assert.deepStrictEqual(resolved, [a, b, [a, b]]);
		}),
	);

	it.effect("refuses a duplicate id at registration, naming the id and both rows' provenance", () =>
		Effect.gen(function* () {
			const [first, second] = [row("a", "1.0.0"), row("a", "2.0.0")];
			const error = yield* Effect.flip(
				Effect.provide(Effect.succeed(undefined), Registry.layer([first, second])),
			);
			assert.instanceOf(error, DuplicateProgramId);
			assert.strictEqual(error.id, "a");
			assert.deepStrictEqual(error.first, provenanceOf(first));
			assert.deepStrictEqual(error.second, provenanceOf(second));
			assert.strictEqual(
				error.message,
				'program id "a" is already registered by @kampus/tuval/a@1.0.0 (sha256:a-1.0.0); refusing @kampus/tuval/a@2.0.0 (sha256:a-2.0.0)',
			);
		}),
	);

	it.effect("fails an unknown id with a typed error, never undefined", () =>
		Effect.gen(function* () {
			const error = yield* withRegistry([row("a")], (registry) =>
				Effect.flip(registry.resolve(ProgramId.make("missing"))),
			);
			assert.instanceOf(error, ProgramNotFound);
			assert.strictEqual(error.id, "missing");
			assert.strictEqual(error.message, 'no program is registered under id "missing"');
		}),
	);
});
