/**
 * What the handlers are allowed to let past them.
 *
 * The row is the seam: a service and a wire type live on the handler side of it, and the core and
 * the five ports live on the other. Two probes hold that. The first is structural — every payload
 * the interface carries is plain data all the way down, so no `Effect`, stream, layer or socket can
 * ride a port, and the `notPlain` rows are the positive controls proving the checker can say
 * `false` (`.patterns/unconditional-test-assertions.md`). The second reads the row's own inferred
 * `R`: `TuvalAiAgent` must not appear on it, because `aiAgentProgram` provides the layer itself and
 * a row still asking for the service would make every spawn need one.
 *
 * The third reads the other half of that `R`: a layer's *own* leftover requirement does ride out
 * onto the row, so a row built over one needing `SpellBridge` says so and a context lacking it
 * cannot satisfy the spawn (#7951).
 *
 * The import scan is the fourth: nothing under this directory names a backend, so the one generic
 * handler set stays generic by construction rather than by intention.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Context, Effect, Layer, type Stream} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {SpellBridge} from "../../commands/bridge/index.ts";
import type {ProcessPorts} from "../../ports/index.ts";
import type {ProcessSelf} from "../../process/self.ts";
import type {JsonValue} from "../ports/index.ts";
import type {AgentPortPayload} from "../ports/ports.ts";
import {type AiAgentProgram, aiAgentProgram} from "../program.ts";
import {plainReply} from "../service/fixtures/scripts.ts";
import {ScriptedAiAgent, type TuvalAiAgent} from "../service/index.ts";
import type {AiAgentHandlerServices} from "./index.ts";

type Primitive = string | number | boolean | null | undefined;

/** Recursive rather than an `extends` check: an interface has no implicit index signature. */
type IsPlainData<T> = T extends Primitive
	? true
	: T extends JsonValue
		? true
		: T extends (...args: never[]) => unknown
			? false
			: T extends ReadonlyArray<infer Element>
				? IsPlainData<Element>
				: T extends object
					? {[K in keyof T]-?: IsPlainData<T[K]>}[keyof T] extends true
						? true
						: false
					: false;

const portPayloadPlain: IsPlainData<AgentPortPayload> = true;

const effectNotPlain: IsPlainData<{readonly work: Effect.Effect<void>}> = false;
const streamNotPlain: IsPlainData<{readonly events: Stream.Stream<number>}> = false;
const layerNotPlain: IsPlainData<{readonly layer: Layer.Layer<never>}> = false;
const socketNotPlain: IsPlainData<{readonly send: (frame: string) => void}> = false;

describe("what crosses the five ports", () => {
	it("is plain data at every depth", () => {
		expect(portPayloadPlain).toBe(true);
	});

	it("has probes that can say false — the controls", () => {
		expect([effectNotPlain, streamNotPlain, layerNotPlain, socketNotPlain]).toEqual([
			false,
			false,
			false,
			false,
		]);
	});
});

describe("the row's inferred requirements", () => {
	it("name the process's own two kernel services and no agent service", () => {
		expectTypeOf<AiAgentHandlerServices>().toEqualTypeOf<ProcessSelf | ProcessPorts>();
		expectTypeOf<Extract<AiAgentHandlerServices, TuvalAiAgent>>().toEqualTypeOf<never>();
	});

	it("are the ones the program row carries", () => {
		type RowServices = AiAgentProgram extends {
			readonly handlers: Record<string, (cmd: never) => Effect.Effect<unknown, unknown, infer R>>;
		}
			? R
			: never;
		expectTypeOf<Extract<RowServices, TuvalAiAgent>>().toEqualTypeOf<never>();
	});
});

/**
 * The agent layer behind a `SpellBridge` it never closes — the shape a Claude row's layer has, with
 * no Claude import. `Layer.unwrap` defers the effect, so building this runs nothing.
 */
const requiringLayer = Layer.unwrap(
	Effect.map(SpellBridge, () => ScriptedAiAgent.layer(plainReply)),
);

const requiringRow = aiAgentProgram({
	id: "requires-spell-bridge",
	layer: requiringLayer,
	config: {cwd: "/tmp"},
});

describe("a row over a layer that still asks for a service", () => {
	it("carries that requirement out instead of closing it", () => {
		expectTypeOf(requiringLayer).toEqualTypeOf<Layer.Layer<TuvalAiAgent, never, SpellBridge>>();
		expectTypeOf(requiringRow).toEqualTypeOf<AiAgentProgram<SpellBridge>>();
		expectTypeOf<AiAgentHandlerServices<SpellBridge>>().toEqualTypeOf<
			ProcessSelf | ProcessPorts | SpellBridge
		>();
	});

	it("still keeps the agent service off its own R", () => {
		expectTypeOf<
			Extract<AiAgentHandlerServices<SpellBridge>, TuvalAiAgent>
		>().toEqualTypeOf<never>();
	});

	it("cannot be spawned with a context that lacks the service", () => {
		// `Processes.spawn` erases `services` to `Context.Context<never>`, so the pairing is only
		// checkable where the row's own `R` is still named. `Context` is contravariant in its services
		// (`effect/Context` rc.112 declares `Context<in Services>`), so one missing a member of that
		// union is not assignable.
		const spawnServices = (_services: Context.Context<AiAgentHandlerServices<SpellBridge>>) => {};
		// @ts-expect-error — `Context.empty()` names no `SpellBridge`.
		spawnServices(Context.empty());
		expect(typeof spawnServices).toBe("function");
	});
});

const sources = () =>
	readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => ({name, text: readFileSync(join(import.meta.dirname, name), "utf8")}));

const importsOf = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");

describe("the handlers' import closure", () => {
	it("names no backend", () => {
		const banned = /(^|\/)(pi|claude)(\/|$)|@earendil-works|@anthropic-ai/;
		const offenders = sources().flatMap(({name, text}) =>
			importsOf(text)
				.filter((specifier) => banned.test(specifier))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});
});
