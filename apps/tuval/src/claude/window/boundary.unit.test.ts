/**
 * The boundaries this slice keeps: what host it may be handed, what its view slot may hold, and
 * what it may import.
 *
 * Half the proof is `tsc` over this file — every `=` probe below is a claim on the right of an
 * assignment, flip-verified per `.patterns/unconditional-test-assertions.md`, "the type-level
 * sibling". The other half is the textual scan, which is the only thing that catches an import
 * added later by a builder who never read this file.
 *
 * The scan walks subdirectories rather than one level, so a proof page or a helper folder added
 * under here is covered the day it lands ([#7886](https://github.com/kamp-us/phoenix/issues/7886)
 * is the Pi-side sibling of that gap).
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {ChatView, ChatWindowRenderer} from "../../shell/chat/index.ts";
import type {
	AnyWindowRenderer,
	ViewState,
	WindowHost,
	WindowRenderer,
} from "../../shell/window/index.ts";
import {CLAUDE_CHAT_WINDOW_REF, CLAUDE_SESSION_PROGRAM} from "../renderer-ref.ts";
import {ClaudeChatWindow} from "./ClaudeChatWindow.tsx";

type CounterState = {readonly count: number};
type CounterMsg = {readonly type: "tick"};

const matching: ChatWindowRenderer = {
	kind: "host-native",
	render: (host: WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>) => host.windowId,
};

const anotherProgram: ChatWindowRenderer = {
	kind: "host-native",
	// @ts-expect-error — a host over another program's state cannot serve the Claude window.
	render: (host: WindowHost<CounterState, CounterMsg, ChatView>) => host.windowId,
};

/**
 * `ClaudeChatWindow` is the window contract's own type at the shared session's parameters, not a
 * lookalike. The probe reads `AnyWindowRenderer` because `WindowRenderer`'s defaults are the
 * *erased* host and `render` is contravariant in it — a renderer over this program's host is
 * deliberately not assignable to one over `WindowHost<unknown, …>`.
 */
const isWindowRenderer: ChatWindowRenderer extends AnyWindowRenderer ? true : false = true;
const isTheSharedRenderer: ChatWindowRenderer extends WindowRenderer<
	unknown,
	AiAgentSessionState,
	AiAgentSessionMsg,
	ChatView
>
	? true
	: false = true;

/**
 * The view slot this renderer is parameterised on is JSON, and `ViewState` is the contract that
 * says so — a `ChatView` carrying a function or a class instance would not satisfy it, so this
 * probe is what refuses one.
 */
const viewIsJson: ChatView extends ViewState ? true : false = true;

const sourcesUnder = (dir: string): ReadonlyArray<readonly [string, string]> =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourcesUnder(path);
		if (!/\.tsx?$/.test(entry)) return [];
		if (entry.includes(".test.") || entry.endsWith(".testing.ts")) return [];
		return [[path, readFileSync(path, "utf8")] as const];
	});

const specifiers = (source: string): ReadonlyArray<string> =>
	[...source.matchAll(/from\s+"([^"]+)"/g), ...source.matchAll(/^import\s+"([^"]+)"/gm)].map(
		(match) => match[1] ?? "",
	);

describe("the Claude window boundary", () => {
	it("resolves at the shared session's own host shape and nothing else", () => {
		expect([matching.kind, anotherProgram.kind]).toEqual(["host-native", "host-native"]);
		expect(isWindowRenderer).toBe(true);
		expect(isTheSharedRenderer).toBe(true);
	});

	it("holds only JSON in its view slot", () => {
		expect(viewIsJson).toBe(true);
	});

	it("imports no Agent SDK, no Claude layer, no kernel tools and no agent service", () => {
		const forbidden = [
			/@anthropic-ai/,
			/claude\/agent\//,
			/^\.\.\/agent\//,
			/claude\/tools\//,
			/^\.\.\/tools\//,
			/^\.\.\/program\.ts$/,
			/ai-agent\/service\//,
			/ai-agent\/handlers\//,
			// A thin renderer that reached the sibling program would be a window bound to two.
			/\/pi\//,
			/^ws$/,
			/^node:/,
			/fate/,
		];
		const offenders = sourcesUnder(import.meta.dirname).flatMap(([name, source]) =>
			specifiers(source)
				.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("keeps the row's renderer reference on a leaf that pulls in no window code", () => {
		const leaf = readFileSync(join(import.meta.dirname, "..", "renderer-ref.ts"), "utf8");
		expect(specifiers(leaf)).toEqual(["../registry/program.ts"]);
		expect([CLAUDE_SESSION_PROGRAM, CLAUDE_CHAT_WINDOW_REF.kind]).toEqual([
			"claude-session",
			"host-native",
		]);
	});

	// That this renderer is what the reference *resolves* to is a fact about the page's table, and
	// is asserted there: `claude-chat-window.unit.test.tsx`, "the row's renderer reference".
	it("answers the kind the reference declares", () => {
		expect(ClaudeChatWindow.kind).toBe(CLAUDE_CHAT_WINDOW_REF.kind);
	});
});
