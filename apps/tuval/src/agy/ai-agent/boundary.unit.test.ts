/**
 * The boundaries this layer keeps: it is ruling 4's `Layer<TuvalAiAgent, never, never>` (#7570),
 * no agy wire type reaches its public surface, it implements every `TuvalAiAgentApi` member rather
 * than the brief's nine, and none of `src/claude/`'s kernel-tool apparatus exists anywhere under
 * `src/agy/`.
 *
 * The surface probe states its expected answer on the right of an `=`, with positive controls
 * pinned to the opposite value, per `.patterns/unconditional-test-assertions.md`'s type-level
 * sibling section — a probe that compiles either way proves nothing, so each control was flipped
 * and confirmed to red with `TS2322` before this file landed.
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import type {FileSystem, Layer} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {describe, expect, it} from "vitest";
import type {TuvalAiAgent, TuvalAiAgentApi} from "../../ai-agent/service/index.ts";
import {AgyAiAgent} from "./index.ts";

/**
 * Ruling 4's shape. `E` is `never` — nothing is acquired at build time, so there is no failure to
 * raise — and `R` is empty: the ruled `Scope` is the scoped layer's own and is not a requirement a
 * `Layer` type carries, so a process provides this layer nothing.
 */
type RuledShape<L> =
	L extends Layer.Layer<infer A, infer E, infer R>
		? [A, E, R] extends [TuvalAiAgent, never, never]
			? true
			: false
		: false;

const surface: RuledShape<ReturnType<typeof AgyAiAgent.layer>> = true;

/** The control: an extra `A` — a layer that also published something of agy's own. */
const publishesMore: RuledShape<Layer.Layer<TuvalAiAgent | FileSystem.FileSystem>> = false;

/** The control: a non-`never` `E` — a launch failure raised at build time rather than at `start`. */
const raisesAtBuild: RuledShape<Layer.Layer<TuvalAiAgent, Error>> = false;

/** The control: a non-`never` `R` — the spawner left for the process to satisfy. */
const requiresTheSpawner: RuledShape<
	Layer.Layer<TuvalAiAgent, never, ChildProcessSpawner.ChildProcessSpawner>
> = false;

/**
 * Every member this file claims the layer implements. Typed on `keyof TuvalAiAgentApi`, so a *wrong*
 * name reds at compile time; the port's own source text below is what makes a *missing* one red,
 * which a hand-kept count could not (the list said ten while the port declared eleven).
 */
const members: ReadonlyArray<keyof TuvalAiAgentApi> = [
	"start",
	"prompt",
	"interrupt",
	"answer",
	"setMode",
	"setModel",
	"commands",
	"setThinkingLevel",
	"page",
	"listSessions",
	"events",
];

const portSource = join(import.meta.dirname, "..", "..", "ai-agent", "service", "TuvalAiAgent.ts");

/** The member names the port's interface declares, read off its text so a new one cannot be missed. */
const declaredMembers = (text: string): ReadonlyArray<string> => {
	const body = /export interface TuvalAiAgentApi \{[\s\S]*?\n\}/.exec(stripComments(text));
	expect(body).not.toBeNull();
	return [...(body?.[0] ?? "").matchAll(/^\treadonly\s+(\w+)/gm)].map(([, name]) => name ?? "");
};

const moduleDir = join(import.meta.dirname, "..");

const sourcesUnder = (dir: string): ReadonlyArray<{name: string; text: string}> =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourcesUnder(path);
		return entry.endsWith(".ts") || entry.endsWith(".tsx")
			? [{name: path.slice(moduleDir.length + 1), text: readFileSync(path, "utf8")}]
			: [];
	});

describe("the agy AI agent layer's surface", () => {
	it("is the ruled shape and provides the interface and nothing else", () => {
		expect([surface, publishesMore, raisesAtBuild, requiresTheSpawner]).toEqual([
			true,
			false,
			false,
			false,
		]);
	});

	it("publishes one layer and nothing beside it", () => {
		expect(Object.keys(AgyAiAgent).sort()).toEqual(["layer"]);
	});

	it("implements every port member the interface declares, by name", () => {
		expect([...members].sort()).toEqual(
			[...declaredMembers(readFileSync(portSource, "utf8"))].sort(),
		);
	});

	it("reds when the port grows a member this list does not name", () => {
		const grown = readFileSync(portSource, "utf8").replace(
			"\treadonly events:",
			"\treadonly rename: Effect.Effect<void>;\n\treadonly events:",
		);
		expect(declaredMembers(grown)).toContain("rename");
		expect(members as ReadonlyArray<string>).not.toContain("rename");
	});

	it("names no agy wire type on the options a process fills in", () => {
		const declared = /export interface AgyAiAgentOptions \{[\s\S]*?\n\}/.exec(
			readFileSync(join(moduleDir, "config.ts"), "utf8"),
		);
		expect(declared).not.toBeNull();
		// The exact set, positively: every type the wire and transcript readers declare, so a name
		// added to either reds here rather than slipping past a fixed substring scan.
		expect(stripComments(declared?.[0] ?? "")).not.toMatch(
			/Agy(Event|Line|Init|StepUpdate|Result|Usage|ToolInfo|ToolError|ToolCall|Subagent|SubagentInfo|TranscriptLine|Turn)\b/,
		);
	});

	it("re-exports no agy wire type through its entry point", () => {
		const entry = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
		// The exact set rather than a scan for forbidden substrings: a scan cannot see
		// `export * from "./AgyAiAgent.ts";`, which is the one escape route the module has (#7791).
		expect(exportedNames(entry)).toEqual([
			"AGY_BINARY",
			"AGY_EFFORTS",
			"AGY_MODELS",
			"AGY_MODES",
			"AGY_RETRY_HINT",
			"AGY_VERSION",
			"AgyAiAgent",
			"AgyAiAgentOptions",
			"AgyMode",
		]);
	});

	it("reds on a departure appended to that entry text", () => {
		const entry = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
		expect(
			[
				'export * from "./AgyAiAgent.ts";',
				'export type {AgyEvent} from "./wire.ts";',
				'export type * from "./wire.ts";',
			].map(
				(departure) =>
					exportedNames(`${entry}\n${departure}\n`).includes("*") ||
					exportedNames(`${entry}\n${departure}\n`).includes("AgyEvent"),
			),
		).toEqual([true, true, true]);
	});
});

describe("this row follows src/pi/, not src/claude/", () => {
	it("has no tools directory anywhere under src/agy/", () => {
		expect(readdirSync(moduleDir).filter((entry) => entry === "tools")).toEqual([]);
	});

	it("names no KernelBridge, no SpellBridge and no scope option in any of its sources", () => {
		const named = sourcesUnder(moduleDir)
			.filter(({name}) => !name.includes(".test."))
			.flatMap(({name, text}) =>
				stripComments(text)
					.split("\n")
					.filter((line) => /\bKernelBridge\b|\bSpellBridge\b|\bscope\?:/.test(line))
					.map((line) => `${name}: ${line.trim()}`),
			);
		expect(named).toEqual([]);
	});
});

/**
 * Every name a module's text publishes, sorted. Some of what `index.ts` re-exports are types and
 * carry no runtime key, so the set is read off the text rather than off the imported module. A star
 * re-export enumerates nothing, so it reports the literal `*` — a name no ruled set carries, which
 * is what makes `export * from "./AgyAiAgent.ts";` red rather than pass unseen (#7791).
 */
const exportedNames = (text: string): ReadonlyArray<string> => {
	const clauses =
		/^export\s+(?:(?:type\s+)?(?:(\*(?:\s+as\s+\w+)?)|\{([^}]*)\})|(default)\b|(?:declare\s+)?(?:async\s+)?(?:type|interface|const|let|var|function\*?|class|enum|namespace)\s+(\w+))/gm;
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
