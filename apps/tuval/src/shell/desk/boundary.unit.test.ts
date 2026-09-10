/**
 * The three boundaries this slice keeps. Two are type-level, so `tsc` over this file is the proof:
 * a renderer written against another program's host is refused where this program's is required,
 * and a status renderer cannot return a rendered bar. The third is textual: nothing here imports a
 * socket, React, or the browser surface.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {WindowHost} from "../window/host.ts";
import type {InspectorRenderer, StatusRenderer, StatusSegment} from "./renderer.ts";

type Chat = {readonly messages: ReadonlyArray<string>};
type ChatMsg = {readonly type: "say"; readonly text: string};
type Scroll = {readonly scroll: number};

type ChatInspector = InspectorRenderer<string, Chat, ChatMsg, Scroll>;
type ChatStatus = StatusRenderer<Chat, ChatMsg, Scroll>;

const inspector: ChatInspector = {
	kind: "host-native",
	render: (host) => `${host.windowId}:${host.view().scroll}`,
};

const notAHost: ChatInspector = {
	kind: "host-native",
	// @ts-expect-error — an inspector takes a `WindowHost`, never a bare record of its own shape.
	render: (panel: {readonly scroll: number}) => String(panel.scroll),
};

const anotherProgram: ChatInspector = {
	kind: "host-native",
	// @ts-expect-error — an inspector typed for another program's state cannot serve this program.
	render: (host: WindowHost<{readonly count: number}, ChatMsg, Scroll>) =>
		String(host.view().scroll),
};

const status: ChatStatus = {
	kind: "host-native",
	segments: (host) => [{id: "messages", text: String(host.view().scroll)}],
};

const statusForAnotherProgram: ChatStatus = {
	kind: "host-native",
	// @ts-expect-error — the same host discipline holds for the status renderer.
	segments: (host: WindowHost<{readonly count: number}, ChatMsg, Scroll>) => [
		{id: "count", text: String(host.view().scroll)},
	],
};

const wholeBar: ChatStatus = {
	kind: "host-native",
	// @ts-expect-error — a status renderer returns segments; a whole bar is not its to return.
	segments: () => ({left: [], middle: [{id: "a", text: "a"}], right: []}),
};

const renderedElement: ChatStatus = {
	kind: "host-native",
	// @ts-expect-error — nor a rendered element standing in for the bar.
	segments: () => "<div class='status'>hello</div>",
};

/** Does `T` inhabit what a status renderer may return? The positive control is the first row. */
type Returnable<T> = T extends ReadonlyArray<StatusSegment> ? true : false;

const segments: Returnable<ReadonlyArray<StatusSegment>> = true;
const oneSegment: Returnable<readonly [{readonly id: string; readonly text: string}]> = true;
const bar: Returnable<{readonly left: []; readonly middle: []; readonly right: []}> = false;
const markup: Returnable<string> = false;

describe("desk boundary", () => {
	it("a desk renderer resolves at its own program's host shape and nothing else", () => {
		expect([inspector.kind, notAHost.kind, anotherProgram.kind]).toEqual([
			"host-native",
			"host-native",
			"host-native",
		]);
		expect([status.kind, statusForAnotherProgram.kind]).toEqual(["host-native", "host-native"]);
	});

	it("a status renderer returns segments, never a bar and never markup", () => {
		expect([segments, oneSegment]).toEqual([true, true]);
		expect([bar, markup]).toEqual([false, false]);
		expect([wholeBar.kind, renderedElement.kind]).toEqual(["host-native", "host-native"]);
	});

	it("nothing in src/shell/desk/ imports a socket, React, or the browser surface", () => {
		const dir = import.meta.dirname;
		const forbidden = [
			/^react/,
			/^@react/,
			/^ws$/,
			/^socket\.io/,
			/^node:net$/,
			/^node:http/,
			/\/shell\/ui\//,
			/^\.\.\/ui\//,
			/^\.\.\/transport\//,
			/^\.\.\/core\//,
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
