/**
 * The three boundaries this layer keeps: it is ruling 4's `Layer<TuvalAiAgent, never, Scope>`
 * (#7570), no Pi type reaches its public surface, and the per-launch token reaches nothing at all.
 *
 * The surface probe states its expected answer on the right of an `=`, with a positive control
 * pinned to the opposite value, per `.patterns/unconditional-test-assertions.md`'s type-level
 * sibling section — a probe that compiles either way proves nothing, so both lines were flipped
 * and confirmed to red with `TS2322` before this file landed.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import type {PiServerService, PiSessionHost, ServerBindFailed} from "../server/index.ts";
import {PiAiAgent} from "./index.ts";

/**
 * Ruling 4's shape. `E` is `never` — a bind failure dies inside the layer — and `R` is empty: the
 * ruled `Scope` is the scoped layer's own and is not a requirement a `Layer` type carries, so a
 * process provides this layer nothing and holds no Pi value of its own.
 */
type RuledShape<L> =
	L extends Layer.Layer<infer A, infer E, infer R>
		? [A, E, R] extends [TuvalAiAgent, never, never]
			? true
			: false
		: false;

const surface: RuledShape<ReturnType<typeof PiAiAgent.layer>> = true;

/** The control: a layer that published the server would publish the token with it. */
const leaksTheServer: RuledShape<Layer.Layer<TuvalAiAgent | PiServerService>> = false;

/** The second control: a departure this test used to pin, now red on the error channel. */
const raisesTheBindFailure: RuledShape<Layer.Layer<TuvalAiAgent, ServerBindFailed>> = false;

/**
 * The third control: the departure round 1 shipped. A `PiSessionHost` in `R` is a Pi-typed
 * requirement the process would have to satisfy, which is the model runtime standing outside the
 * layer ruling 4 puts it inside.
 */
const requiresTheHost: RuledShape<Layer.Layer<TuvalAiAgent, never, PiSessionHost>> = false;

describe("the Pi AI agent layer's surface", () => {
	it("is the ruled shape and provides the interface and nothing else", () => {
		expect([surface, leaksTheServer, raisesTheBindFailure, requiresTheHost]).toEqual([
			true,
			false,
			false,
			false,
		]);
	});

	it("publishes one layer and its own options", () => {
		expect(Object.keys(PiAiAgent).sort()).toEqual(["layer"]);
	});

	it("names no Pi type on the options a process fills in", () => {
		const declared = /export interface PiAiAgentOptions \{[\s\S]*?\n\}/.exec(
			readFileSync(join(import.meta.dirname, "PiAiAgent.ts"), "utf8"),
		);
		expect(declared).not.toBeNull();
		expect(stripComments(declared?.[0] ?? "")).not.toMatch(
			/@earendil-works|ModelRuntime|PiSessionHost/,
		);
	});

	it("re-exports no Pi type through its entry point", () => {
		const entry = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
		// The exact set, not a scan for forbidden substrings: the scan this replaced looked for
		// `@earendil-works` and `from "../server|client/"`, and `export {aiAgentOverHost} from
		// "./PiAiAgent.ts";` carries neither, so the one escape route the module has stayed green
		// under it (#7791). A positive set reds on any fourth name however it is spelled — do not
		// restore the regexes.
		expect(exportedNames(entry)).toEqual(["ModelSelection", "PiAiAgent", "PiAiAgentOptions"]);
		// The control: each departure appended to the real entry text, so the set above is what reds
		// on it. `aiAgentOverHost` and `aiAgentOverClient` both publish a Pi-typed `R`, and a star
		// re-export publishes whatever `PiAiAgent.ts` grows next.
		expect(
			[
				'export {aiAgentOverHost} from "./PiAiAgent.ts";',
				'export {aiAgentOverClient} from "./PiAiAgent.ts";',
				'export * from "./PiAiAgent.ts";',
			].map((departure) => exportedNames(`${entry}\n${departure}\n`)),
		).toEqual([
			["ModelSelection", "PiAiAgent", "PiAiAgentOptions", "aiAgentOverHost"],
			["ModelSelection", "PiAiAgent", "PiAiAgentOptions", "aiAgentOverClient"],
			["*", "ModelSelection", "PiAiAgent", "PiAiAgentOptions"],
		]);
	});
});

describe("the per-launch token", () => {
	it("is named by no source under this module", () => {
		const named = sources().flatMap(({name, text}) =>
			stripComments(text)
				.split("\n")
				.filter((line) => /\btoken\b/i.test(line))
				.map((line) => `${name}: ${line.trim()}`),
		);
		expect(named).toEqual([]);
	});
});

const sources = (): ReadonlyArray<{name: string; text: string}> => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts") && !name.includes(".test."))
		.map((name) => ({name, text: readFileSync(join(dir, name), "utf8")}));
};

/**
 * Every name a module's text publishes, sorted. Two of the three names `index.ts` exports are types
 * and carry no runtime key, so the set is read off the text rather than off the imported module. A
 * star re-export enumerates nothing, so it reports the literal `*` — a name no ruled set carries,
 * which is what makes `export * from "./PiAiAgent.ts";` red rather than pass unseen.
 */
const exportedNames = (text: string): ReadonlyArray<string> => {
	const clauses =
		/^export\s+(?:(\*(?:\s+as\s+\w+)?)|\{([^}]*)\}|(default)\b|(?:declare\s+)?(?:async\s+)?(?:type|interface|const|let|var|function\*?|class|enum|namespace)\s+(\w+))/gm;
	const names: Array<string> = [];
	for (const [, star, clause, fallback, declared] of stripComments(text).matchAll(clauses)) {
		if (star !== undefined) names.push("*");
		else if (clause !== undefined) names.push(...clause.split(",").flatMap(exportedName));
		else names.push(fallback ?? declared ?? "");
	}
	return names.sort();
};

/** One specifier out of an `export {...}` clause: `type A`, `A as B` and `A` all name what lands. */
const exportedName = (specifier: string): ReadonlyArray<string> => {
	const named = specifier
		.trim()
		.replace(/^type\s+/, "")
		.split(/\s+as\s+/);
	const landed = named.at(-1) ?? "";
	return landed === "" ? [] : [landed];
};

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
