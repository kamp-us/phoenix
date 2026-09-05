/**
 * The boundary this directory keeps: the layer satisfies the generic service exactly, the Agent
 * SDK's surface stops at `src/claude/`, and the layer's own requirement is one service the row
 * provides.
 *
 * The type pins are exact rather than "assignable to": an assignability check passes a layer that
 * grew a second requirement, which is the whole thing being refused.
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {Layer} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {Mode} from "../../ai-agent/ports/index.ts";
import type {TuvalAiAgent, TuvalAiAgentApi} from "../../ai-agent/service/index.ts";
import type {SpellBridge} from "../../commands/bridge/index.ts";
import {ClientId, type Scope, WorkspaceId} from "../../commands/spell.ts";
import {KernelBridge} from "../tools/index.ts";
import {ClaudeAiAgent} from "./ClaudeAiAgent.ts";
import type {ClaudeAiAgentOptions} from "./options.ts";

// Real values rather than `declare const`: `expectTypeOf` evaluates its argument, and building a
// layer runs nothing — `Layer.effect` defers the whole body until something provides it.
const options: ClaudeAiAgentOptions = {
	permissionMode: Mode.make("default"),
	modes: [Mode.make("default")],
	allowedTools: [],
};

const windowScope: Scope = {
	workspace: WorkspaceId.make("w"),
	client: ClientId.make("c"),
};

const sourcesUnder = (dir: string): ReadonlyArray<{name: string; text: string}> =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourcesUnder(path);
		return entry.endsWith(".ts") ? [{name: path, text: readFileSync(path, "utf8")}] : [];
	});

const specifiersOf = (text: string): ReadonlyArray<string> =>
	[...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

describe("the layer's type", () => {
	it("satisfies TuvalAiAgent and asks for exactly KernelBridge", () => {
		expectTypeOf(ClaudeAiAgent.layer(options)).toEqualTypeOf<
			Layer.Layer<TuvalAiAgent, never, KernelBridge>
		>();
	});

	it("needs only the kernel's spell bridge once the row provides KernelBridge.live", () => {
		// The row's own wiring: `KernelBridge.live` takes the calling process's window scope and
		// speaks the kernel's `process` spells, so what reaches `aiAgentProgram` asks for nothing
		// this program knows about.
		const composed = Layer.provide(ClaudeAiAgent.layer(options), KernelBridge.live(windowScope));
		expectTypeOf(composed).toEqualTypeOf<Layer.Layer<TuvalAiAgent, never, SpellBridge>>();
	});

	it("implements exactly the eight generic members, and no ninth", () => {
		expectTypeOf<keyof TuvalAiAgentApi>().toEqualTypeOf<
			"start" | "prompt" | "interrupt" | "answer" | "setMode" | "setModel" | "page" | "events"
		>();
	});
});

describe("the module a process imports", () => {
	it("names no Agent SDK type on its own surface", () => {
		const text = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
		expect(specifiersOf(text).filter((one) => one.startsWith("@anthropic-ai/"))).toEqual([]);
	});
});

describe("the Agent SDK stops at src/claude", () => {
	it("is named nowhere else in the app", () => {
		const root = join(import.meta.dirname, "..", "..");
		const offenders = sourcesUnder(root)
			.filter(({name}) => !name.includes(`${join("src", "claude")}`))
			.flatMap(({name, text}) =>
				specifiersOf(text)
					.filter((specifier) => specifier.startsWith("@anthropic-ai/"))
					.map((specifier) => `${name}: ${specifier}`),
			);
		expect(offenders).toEqual([]);
	});

	it("reaches no other program's directory from here", () => {
		const offenders = sourcesUnder(import.meta.dirname).flatMap(({name, text}) =>
			specifiersOf(text)
				.filter((specifier) => specifier.includes("/pi/") || specifier.includes("../../pi"))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});
});

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the layer holds no retry loop", () => {
	it("names no retry, repeat, schedule or reconnect — that policy is the machine's data (#7371)", () => {
		const offenders = sourcesUnder(import.meta.dirname)
			.filter(({name}) => !name.endsWith(".unit.test.ts") && !name.includes("fixtures"))
			.flatMap(({name, text}) =>
				stripComments(text)
					.split("\n")
					.filter((line) =>
						/\b(Effect\.retry|Effect\.repeat|Schedule\.|reconnect|respawn)\b/.test(line),
					)
					.map((line) => `${name}: ${line.trim()}`),
			);
		expect(offenders).toEqual([]);
	});
});
