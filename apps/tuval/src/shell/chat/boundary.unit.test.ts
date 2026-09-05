/**
 * The four boundaries this slice keeps. Two are textual and two are type-level, so `tsc` over this
 * file is half the proof.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import type {AnyWindowRenderer, ViewState, WindowHost} from "../window/index.ts";
import type {ChatWindowRenderer} from "./ChatWindow.tsx";
import type {ChatView} from "./view.ts";

/**
 * The slot is `Schema.Json`, and `ChatView` has to be a member of it or no window can hold one.
 *
 * The probe is an **assignment**, not the `V extends ViewState ? true : false` form the window
 * contract's own boundary test uses, because that form does not discriminate here: at the pin
 * (`effect@4.0.0-rc.112`, `Schema.Json` = `… | JsonObject`, `JsonObject` an interface with
 * `readonly [x: string]: Json`) a conditional `extends` answers `true` for an interface source
 * while a plain assignment of that same interface refuses. The assignment is the one that reads
 * the rule this file exists to hold.
 */
const chatViewFitsTheSlot: ViewState = {
	scroll: 0,
	draft: "",
	cursor: null,
	atOldest: false,
	expanded: [],
} satisfies ChatView;

/**
 * The positive control, and the reason `ChatView` is a type alias: TypeScript gives an object type
 * *alias* the implicit index signature `JsonObject` needs, and gives an interface none — because a
 * later declaration may widen an interface.
 */
interface ChatViewAsInterface {
	readonly scroll: number;
	readonly draft: string;
	readonly cursor: string | null;
	readonly atOldest: boolean;
	readonly expanded: ReadonlyArray<string>;
}
const asInterface = {
	scroll: 0,
	draft: "",
	cursor: null,
	atOldest: false,
	expanded: [],
} as ChatViewAsInterface;
// @ts-expect-error — an interface-shaped view record is not a `Schema.Json` member, so no window
// could hold it and `ChatView` must not become one.
const interfaceMisfitsTheSlot: ViewState = asInterface;

type CounterState = {readonly count: number};
type CounterMsg = {readonly type: "tick"};

const matching: ChatWindowRenderer = {
	kind: "host-native",
	render: (host: WindowHost<AiAgentSessionState, AiAgentSessionMsg, ChatView>) => host.windowId,
};

const anotherProgram: ChatWindowRenderer = {
	kind: "host-native",
	// @ts-expect-error — a host over another program's state cannot serve the chat window.
	render: (host: WindowHost<CounterState, CounterMsg, ChatView>) => host.windowId,
};

const anotherSlot: ChatWindowRenderer = {
	kind: "host-native",
	// @ts-expect-error — and neither can a host whose view slot is another window's record.
	render: (host: WindowHost<AiAgentSessionState, AiAgentSessionMsg, {readonly page: number}>) =>
		host.windowId,
};

/**
 * The renderer is the window contract's own type at this program's parameters, not a lookalike.
 * The probe reads `AnyWindowRenderer` because `WindowRenderer`'s own defaults are the *erased*
 * host, and `render` is contravariant in it — a renderer over this program's host is deliberately
 * not assignable to one over `WindowHost<unknown, …>`, which is exactly the refusal below.
 */
const isWindowRenderer: ChatWindowRenderer extends AnyWindowRenderer ? true : false = true;

const sourceFiles = (): ReadonlyArray<readonly [string, string]> => {
	const dir = import.meta.dirname;
	return readdirSync(dir)
		.filter((name) => /\.tsx?$/.test(name))
		.filter((name) => !name.includes(".test.") && !name.endsWith(".testing.ts"))
		.map((name) => [name, readFileSync(join(dir, name), "utf8")] as const);
};

const importLines = (source: string): ReadonlyArray<string> =>
	source.split("\n").filter((line) => /^import\b/.test(line) || /^\s*}\s*from\s+"/.test(line));

describe("chat window boundary", () => {
	it("the view slot admits this window's record and refuses an interface-shaped one", () => {
		expect(chatViewFitsTheSlot).toEqual({
			scroll: 0,
			draft: "",
			cursor: null,
			atOldest: false,
			expanded: [],
		});
		expect(interfaceMisfitsTheSlot).toBe(asInterface);
		expect(isWindowRenderer).toBe(true);
	});

	it("a renderer resolves at this program's own host shape and nothing else", () => {
		expect([matching.kind, anotherProgram.kind, anotherSlot.kind]).toEqual([
			"host-native",
			"host-native",
			"host-native",
		]);
	});

	it("nothing here imports a backend, a socket, or the agent service", () => {
		const forbidden = [
			/\/pi\//,
			/\/claude\//,
			/ai-agent\/service\//,
			/ai-agent\/handlers\//,
			/^ws$/,
			/^node:/,
			/@earendil-works/,
			/@anthropic-ai/,
			/fate/,
		];
		const offenders = sourceFiles().flatMap(([name, source]) =>
			[...source.matchAll(/from\s+"([^"]+)"/g)]
				.map((match) => match[1] ?? "")
				.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("writes only failure tags the core's own refusals declare", () => {
		const failures = readFileSync(
			join(import.meta.dirname, "..", "..", "ai-agent", "core", "failures.ts"),
			"utf8",
		);
		const declared = new Set(
			[...failures.matchAll(/"(tuval\/ai-agent\/[A-Za-z]+)"/g)].map((match) => match[1]),
		);
		const written = sourceFiles().flatMap(([name, source]) =>
			[...source.matchAll(/"(tuval\/ai-agent\/[A-Za-z]+)"/g)].map(
				(match) => [name, match[1]] as const,
			),
		);
		expect(written.length).toBeGreaterThan(0);
		expect(written.filter(([, tag]) => tag === undefined || !declared.has(tag))).toEqual([]);
	});

	it("every agent import is type-only, so no agent code reaches the browser bundle", () => {
		const offenders = sourceFiles().flatMap(([name, source]) =>
			importLines(source)
				.filter((line) => line.includes("ai-agent/"))
				.filter((line) => !/^import type\b/.test(line))
				.map((line) => `${name}: ${line.trim()}`),
		);
		expect(offenders).toEqual([]);
	});
});
