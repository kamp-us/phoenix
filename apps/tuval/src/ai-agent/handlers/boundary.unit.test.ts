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
 * The import scan is the third: nothing under this directory names a backend, so the one generic
 * handler set stays generic by construction rather than by intention.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Effect, Layer, Stream} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {ProcessPorts} from "../../ports/index.ts";
import type {ProcessSelf} from "../../process/self.ts";
import type {JsonValue} from "../ports/index.ts";
import type {AgentPortPayload} from "../ports/ports.ts";
import type {AiAgentProgram} from "../program.ts";
import type {TuvalAiAgent} from "../service/index.ts";
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
