/**
 * The two boundaries this module keeps: no payload type names anything model-specific (type-level,
 * so `tsc` over this file is half the proof and a scan of the sources is the other half), and the
 * interface travels alone — importing it reaches nothing else under `src/ai-agent/`.
 *
 * The source scan is per file rather than global, because one source is allowed one word: see
 * `EXEMPT` at the foot of this file.
 */

import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {describe, expect, expectTypeOf, it} from "vitest";
import {agentPorts, agentSide, windowPorts, windowSide} from "../../ai-agent-fixtures/programs.ts";
import type {InPort, OutPort} from "../../registry/program.ts";
import type {
	ModePayload,
	ModeSet,
	PermissionPayload,
	PermissionPendingSet,
	PermissionRequest,
	PromptPayload,
	TranscriptPagePayload,
	TranscriptPageReply,
	TranscriptPayload,
	WindowOmission,
} from "./payloads.ts";
import type {AgentPortPayload} from "./ports.ts";
import type {SubagentSlot} from "./subagent.ts";
import type {ResultOmission, ToolResult, TranscriptItem} from "./transcript-item.ts";

/** Everything a backend knows about a turn that the interface deliberately refuses to carry. */
type ModelSpecific =
	| "model"
	| "modelName"
	| "provider"
	| "cost"
	| "usage"
	| "tokens"
	| "inputTokens"
	| "outputTokens"
	| "session"
	| "sessionId"
	| "sdk"
	| "pi";

/** Distributes over a union, so one line covers every member of a two-way payload. */
type ModelSpecificKeysOf<T> = T extends unknown ? Extract<keyof T, ModelSpecific> : never;

describe("the AI agent interface is model-blind", () => {
	it("names nothing model-specific on any payload type or item kind", () => {
		expectTypeOf<ModelSpecificKeysOf<TranscriptItem>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<ToolResult>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<ResultOmission>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<WindowOmission>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<PermissionRequest>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<TranscriptPayload>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<TranscriptPagePayload>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<PromptPayload>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<PermissionPayload>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<ModePayload>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<AgentPortPayload>>().toEqualTypeOf<never>();
	});

	// The subagent slot's one exemption, spelled out rather than left off the list above: a token
	// count is a plain number every backend that spawns workers reports, and the running row Q1
	// rules shows it (#8384). Everything else model-specific is still refused on this type.
	it("names nothing model-specific on the subagent slot but its token count", () => {
		expectTypeOf<Exclude<ModelSpecificKeysOf<SubagentSlot>, "tokens">>().toEqualTypeOf<never>();
	});

	it("names no model-specific field in the sources either, comments aside", () => {
		const offenders = sources().flatMap(({name, text}) => {
			const banned = banFor(name);
			return stripSpecifiers(stripComments(text))
				.split("\n")
				.filter((line) => banned.test(line))
				.map((line) => `${name}: ${line.trim()}`);
		});
		expect(offenders).toEqual([]);
	});

	it("still guards the seven other words in the one file the model exemption covers", () => {
		const banned = banFor("model.ts");
		expect(banned.test("readonly provider?: string;")).toBe(false);
		for (const word of ["cost", "usage", "tokens", "session", "sessionId", "sdk", "modelName"]) {
			expect(banned.test(`readonly ${word}: string;`), word).toBe(true);
		}
	});

	it("still guards the eight other words in the file the token exemption covers", () => {
		const banned = banFor("subagent.ts");
		expect(banned.test("readonly tokens: number;")).toBe(false);
		for (const word of ["model", "modelName", "provider", "cost", "usage", "session", "sdk"]) {
			expect(banned.test(`readonly ${word}: string;`), word).toBe(true);
		}
		expect(banned.test("readonly sessionId: string;")).toBe(true);
	});
});

describe("the AI agent interface travels alone", () => {
	it("reaches nothing else under src/ai-agent/ from its entry point", () => {
		const root = resolve(import.meta.dirname, "..", "..");
		const seen = new Set<string>();
		const outside: string[] = [];
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const specifier of importsOf(readFileSync(file, "utf8"))) {
				if (!specifier.startsWith(".")) continue;
				const target = resolve(dirname(file), specifier);
				if (!target.startsWith(join(root, "ai-agent"))) continue;
				if (!target.startsWith(join(root, "ai-agent", "ports"))) {
					outside.push(`${file.slice(root.length + 1)} -> ${specifier}`);
					continue;
				}
				walk(target);
			}
		};
		walk(join(root, "ai-agent", "ports", "index.ts"));
		expect(outside).toEqual([]);
		expect(seen.size).toBeGreaterThan(1);
	});

	it("imports nothing from another agent implementation", () => {
		const offenders = sources().flatMap(({name, text}) =>
			importsOf(text)
				.filter((s) => /(^|\/)(pi|claude|shell)(\/|$)/.test(s))
				.map((s) => `${name}: ${s}`),
		);
		expect(offenders).toEqual([]);
	});

	it("lets a program outside the directory declare all five ports and typecheck", () => {
		expectTypeOf(agentPorts.transcript).toEqualTypeOf<OutPort<TranscriptPayload>>();
		expectTypeOf(agentPorts.prompt).toEqualTypeOf<InPort<PromptPayload>>();
		expectTypeOf(windowPorts.prompt).toEqualTypeOf<OutPort<PromptPayload>>();
		// An end of a two-way port is typed to its own direction, not the whole kind (#8235).
		expectTypeOf(windowPorts.pageReply).toEqualTypeOf<InPort<TranscriptPageReply>>();
		expectTypeOf(agentPorts.permissionPending).toEqualTypeOf<OutPort<PermissionPendingSet>>();
		expectTypeOf(agentPorts.modeSet).toEqualTypeOf<InPort<ModeSet>>();

		const ports = {...agentSide.ports, ...windowSide.ports};
		expect(new Set(Object.values(ports).map((port) => port.kind)).size).toBe(5);
		expect(Object.values(agentSide.ports).filter((port) => port.direction === "in").length).toBe(4);
		expect(Object.values(agentSide.ports).filter((port) => port.direction === "out").length).toBe(
			4,
		);
	});
});

const sources = () => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"))
		.map((name) => ({name, text: readFileSync(join(dir, name), "utf8")}));
};

const importsOf = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");

const BANNED = [
	"modelName",
	"model",
	"provider",
	"cost",
	"usage",
	"tokens",
	"sessionId",
	"session",
	"sdk",
] as const;

/**
 * The words one source may say, and the only ones. `model.ts` is where the interface names a model
 * (#7981), so it is scanned under a narrowed ban rather than skipped by name: exempting `model` and
 * `provider` there leaves the other seven binding, where skipping the file stopped guarding `cost`,
 * `usage`, `tokens`, `session`, `sessionId` and `sdk` in the one source most likely to reach for
 * them.
 */
const EXEMPT: Readonly<Record<string, ReadonlyArray<string>>> = {
	"model.ts": ["model", "provider"],
	// `subagent.ts` carries the running worker's token count, which Q11 puts on the port (#8384).
	// Narrowed the same way `model.ts` is: the other eight words stay banned in the one source most
	// likely to reach for them, because a count is model-blind and a model name is not.
	"subagent.ts": ["tokens"],
};

const banFor = (name: string) => {
	const exempt = new Set(EXEMPT[name] ?? []);
	const words = BANNED.filter((word) => !exempt.has(word));
	return new RegExp(String.raw`\b(${words.join("|")})\b`, "i");
};

/** A module path is not a field name, and `./model.ts` is one this directory now imports. */
const stripSpecifiers = (text: string) => text.replace(/from\s+"[^"]+"/g, "");

const stripComments = (text: string) =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
