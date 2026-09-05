/**
 * The boundaries this slice keeps: what it may import, and what host it may be handed.
 *
 * Half the proof is `tsc` over this file — every `=` probe below is a claim on the right of an
 * assignment, flip-verified per `.patterns/unconditional-test-assertions.md`, "the type-level
 * sibling". The other half is the textual scan, which is the only thing that catches an import
 * added later by a builder who never read this file.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {ChatView, ChatWindowRenderer} from "../../shell/chat/index.ts";
import type {AnyWindowRenderer, WindowHost, WindowRenderer} from "../../shell/window/index.ts";
import {PI_CHAT_WINDOW_REF} from "../renderer-ref.ts";

type CounterState = {readonly count: number};
type CounterMsg = {readonly type: "tick"};

const matching: ChatWindowRenderer = {
	kind: "host-native",
	render: (host: WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>) => host.windowId,
};

const anotherProgram: ChatWindowRenderer = {
	kind: "host-native",
	// @ts-expect-error — a host over another program's state cannot serve the Pi window.
	render: (host: WindowHost<CounterState, CounterMsg, ChatView>) => host.windowId,
};

/**
 * `PiChatWindow` is the window contract's own type at the shared session's parameters, not a
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

const sourceFiles = (): ReadonlyArray<readonly [string, string]> => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => /\.tsx?$/.test(name))
		.filter((name) => !name.includes(".test.") && !name.endsWith(".testing.ts"))
		.map((name) => [name, readFileSync(join(dir, name), "utf8")] as const);
};

const specifiers = (source: string): ReadonlyArray<string> =>
	[...source.matchAll(/from\s+"([^"]+)"/g), ...source.matchAll(/^import\s+"([^"]+)"/gm)].map(
		(match) => match[1] ?? "",
	);

describe("the Pi window boundary", () => {
	it("resolves at the shared session's own host shape and nothing else", () => {
		expect([matching.kind, anotherProgram.kind]).toEqual(["host-native", "host-native"]);
		expect(isWindowRenderer).toBe(true);
		expect(isTheSharedRenderer).toBe(true);
	});

	it("imports no socket, no Pi server, no Pi client and no agent layer", () => {
		const forbidden = [
			/\/server\//,
			/\/client\//,
			/pi\/ai-agent\//,
			/^\.\.\/ai-agent\//,
			/^\.\.\/program\.ts$/,
			/ai-agent\/service\//,
			/ai-agent\/handlers\//,
			/^ws$/,
			/^node:/,
			/@earendil-works/,
			/@anthropic-ai/,
			/fate/,
		];
		const offenders = sourceFiles().flatMap(([name, source]) =>
			specifiers(source)
				.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("keeps the row's renderer reference on a leaf that pulls in no window code", () => {
		const leaf = readFileSync(join(import.meta.dirname, "..", "renderer-ref.ts"), "utf8");
		expect(specifiers(leaf)).toEqual(["../registry/program.ts"]);
		expect(PI_CHAT_WINDOW_REF.kind).toBe("host-native");
	});
});
