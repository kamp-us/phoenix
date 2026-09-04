/**
 * The three boundaries this slice keeps. The first is type-level, so `tsc` over this file is the
 * proof: what `attach` hands back for one process IS the pair the window contract's `WindowHost`
 * declares — a renderer written against a host cannot tell a socket from the in-process double.
 * The second is that a socket keeps no page state. The third is textual: nothing here renders.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {Message} from "../../process/process.ts";
import type {ViewState, WindowHost} from "../window/host.ts";
import type {AttachedProcess} from "./client.ts";
import type {SocketSession} from "./server.ts";

type Chat = {readonly messages: ReadonlyArray<string>};
type ChatMsg = {readonly type: "say"; readonly text: string};
type Scroll = {readonly scroll: number};

/** The two `WindowHost` members a transport owes; `windowId`, `view` and `setView` are the shell's. */
type HostPair<S, M extends Message, V extends ViewState> = Pick<
	WindowHost<S, M, V>,
	"processId" | "readProcess" | "dispatch"
>;

type Satisfies<A, B> = A extends B ? true : false;

const attachedIsAHostPair: Satisfies<
	AttachedProcess<Chat, ChatMsg>,
	HostPair<Chat, ChatMsg, Scroll>
> = true;

const anotherProgramsHostPair: Satisfies<
	AttachedProcess<Chat, ChatMsg>,
	HostPair<{readonly count: number}, ChatMsg, Scroll>
> = false;

describe("transport boundary", () => {
	it("an attached process is exactly the readProcess and dispatch a WindowHost declares", () => {
		expectTypeOf<AttachedProcess<Chat, ChatMsg>["readProcess"]>().toEqualTypeOf<
			WindowHost<Chat, ChatMsg, Scroll>["readProcess"]
		>();
		expectTypeOf<AttachedProcess<Chat, ChatMsg>["dispatch"]>().toEqualTypeOf<
			WindowHost<Chat, ChatMsg, Scroll>["dispatch"]
		>();
		expectTypeOf<AttachedProcess<Chat, ChatMsg>["processId"]>().toEqualTypeOf<
			WindowHost<Chat, ChatMsg, Scroll>["processId"]
		>();
		expect([attachedIsAHostPair, anotherProgramsHostPair]).toEqual([true, false]);
	});

	it("the transport never owns a window's view slot: that is the shell process's state", () => {
		expectTypeOf<AttachedProcess>().not.toHaveProperty("view");
		expectTypeOf<AttachedProcess>().not.toHaveProperty("setView");
		expectTypeOf<AttachedProcess>().not.toHaveProperty("windowId");
	});

	it("a socket keeps its attached process ids and nothing else", () => {
		expectTypeOf<keyof SocketSession>().toEqualTypeOf<"attached">();
	});

	it("nothing under src/shell/transport/ keeps per-client UI state", () => {
		// Every noun the founder's ruling names as shell-process state (#7556 amendment 2). A file
		// here mentioning one is either storing it or explaining why it does not; the prose lives in
		// the two module docblocks, and this asserts the exact set of files allowed to say so.
		const uiState = /\b(layout|focus|workspace|scroll|draft|composer)\b/i;
		const explained = new Set(["client.ts", "server.ts", "boundary.unit.test.ts"]);
		const dir = import.meta.dirname;
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts") && !explained.has(name))
			.filter((name) => uiState.test(readFileSync(join(dir, name), "utf8")));
		expect(offenders).toEqual([]);
		// And in the two that explain it, every mention is inside a comment, never in code.
		const inCode = [...explained]
			.filter((name) => name !== "boundary.unit.test.ts")
			.flatMap((name) =>
				readFileSync(join(dir, name), "utf8")
					.split("\n")
					.filter((line) => uiState.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line))
					.map((line) => `${name}: ${line.trim()}`),
			);
		expect(inCode).toEqual([]);
	});

	it("nothing under src/shell/transport/ renders or imports a UI dependency", () => {
		const dir = import.meta.dirname;
		const ui = [/^react/, /^@react/, /^@xyflow/, /^vite$/, /\.tsx$/, /^@kampus\/ui/];
		const names = readdirSync(dir);
		expect(names.filter((name) => name.endsWith(".tsx"))).toEqual([]);
		const offenders = names
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers
					.filter((s) => ui.some((pattern) => pattern.test(s)))
					.map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
