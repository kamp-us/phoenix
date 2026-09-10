/**
 * The three boundaries this slice keeps. Two are type-level, so `tsc` over this file is the proof:
 * the view slot admits only JSON, and a renderer written for another host shape is refused where a
 * program's renderer is required. The third is textual: nothing here imports a socket, React or the
 * shell core.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {ViewState, WindowHost} from "./host.ts";
import type {WindowRenderer} from "./renderer.ts";

type Chat = {readonly messages: ReadonlyArray<string>};
type ChatMsg = {readonly type: "say"; readonly text: string};
type Scroll = {readonly scroll: number};

type AdmitsView<V> = V extends ViewState ? true : false;

const scrollRecord: AdmitsView<Scroll> = true;
const nestedRecord: AdmitsView<{readonly cursor: {readonly line: number; readonly col: number}}> =
	true;
const listOfStrings: AdmitsView<ReadonlyArray<string>> = true;
const bareFunction: AdmitsView<() => void> = false;
const recordHoldingFunction: AdmitsView<{readonly onScroll: () => void}> = false;
const effectValue: AdmitsView<Effect.Effect<void>> = false;

type ChatRenderer = WindowRenderer<string, Chat, ChatMsg, Scroll>;

const matching: ChatRenderer = {
	kind: "host-native",
	render: (host) => `${host.windowId}:${host.view().scroll}`,
};

const notAHost: ChatRenderer = {
	kind: "host-native",
	// @ts-expect-error — a renderer takes a `WindowHost`, never a bare record of its own shape.
	render: (pane: {readonly scroll: number}) => String(pane.scroll),
};

const anotherProgram: ChatRenderer = {
	kind: "host-native",
	// @ts-expect-error — a renderer typed for another program's state cannot serve this program's window.
	render: (host: WindowHost<{readonly count: number}, ChatMsg, Scroll>) =>
		String(host.view().scroll),
};

// @ts-expect-error — the view slot is constrained to JSON, so a record holding a function is refused.
const functionInTheSlot: WindowHost<Chat, ChatMsg, {readonly onScroll: () => void}> | undefined =
	undefined;

// @ts-expect-error — and so is a bare function.
const functionAsTheSlot: WindowHost<Chat, ChatMsg, () => void> | undefined = undefined;

describe("window boundary", () => {
	it("the view slot admits JSON records and refuses anything holding a function", () => {
		expect([scrollRecord, nestedRecord, listOfStrings]).toEqual([true, true, true]);
		expect([bareFunction, recordHoldingFunction, effectValue]).toEqual([false, false, false]);
		expect(functionInTheSlot).toBeUndefined();
		expect(functionAsTheSlot).toBeUndefined();
	});

	it("a renderer resolves at the program's own host shape and nothing else", () => {
		expect([matching.kind, notAHost.kind, anotherProgram.kind]).toEqual([
			"host-native",
			"host-native",
			"host-native",
		]);
	});

	it("nothing in src/shell/window/ imports a socket, React, or the shell core", () => {
		const dir = import.meta.dirname;
		const forbidden = [
			/^react/,
			/^@react/,
			/^ws$/,
			/^socket\.io/,
			/^node:net$/,
			/^node:http/,
			/\/shell\/core\//,
			/^\.\.\/core\//,
			/^\.\.\/transport\//,
			/\.tsx$/,
		];
		const names = readdirSync(dir);
		expect(names.filter((name) => name.endsWith(".tsx"))).toEqual([]);
		const offenders = names
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers
					.filter((s) => forbidden.some((pattern) => pattern.test(s)))
					.map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
