/**
 * The two boundaries this module keeps: no payload type names anything model-specific (type-level,
 * so `tsc` over this file is half the proof and a scan of the sources is the other half), and the
 * interface travels alone — importing it reaches nothing else under `src/ai-agent/`.
 */

import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {describe, expect, expectTypeOf, it} from "vitest";
import {agentPorts, agentSide, windowPorts, windowSide} from "../../ai-agent-fixtures/programs.ts";
import type {InPort, OutPort} from "../../registry/program.ts";
import type {
	ModePayload,
	PermissionPayload,
	PermissionRequest,
	PromptPayload,
	TranscriptPagePayload,
	TranscriptPayload,
	WindowOmission,
} from "./payloads.ts";
import type {AgentPortPayload} from "./ports.ts";
import type {
	AssistantItem,
	ResultOmission,
	SystemItem,
	ToolItem,
	ToolResult,
	UserItem,
} from "./transcript-item.ts";

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
		expectTypeOf<ModelSpecificKeysOf<UserItem>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<AssistantItem>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<ToolItem>>().toEqualTypeOf<never>();
		expectTypeOf<ModelSpecificKeysOf<SystemItem>>().toEqualTypeOf<never>();
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

	it("names no model-specific field in the sources either, comments aside", () => {
		const banned = /\b(model|modelName|provider|cost|usage|tokens|session|sessionId|sdk)\b/i;
		const offenders = sources().flatMap(({name, text}) =>
			stripComments(text)
				.split("\n")
				.filter((line) => banned.test(line))
				.map((line) => `${name}: ${line.trim()}`),
		);
		expect(offenders).toEqual([]);
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
		expectTypeOf(windowPorts.pageReply).toEqualTypeOf<InPort<TranscriptPagePayload>>();
		expectTypeOf(agentPorts.permissionPending).toEqualTypeOf<OutPort<PermissionPayload>>();
		expectTypeOf(agentPorts.modeSet).toEqualTypeOf<InPort<ModePayload>>();

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

const stripComments = (text: string) =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
