/**
 * The window contract's runtime claims: two windows over one process share its state and own their
 * view slots, and both fallbacks are values a caller matches on rather than exceptions it catches.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Option, Stream} from "effect";
import {ProcessId} from "../../process/process.ts";
import {counterRow, noRendererRow, testProcess} from "./fixtures.ts";
import {
	empty,
	isEmpty,
	isProcessGone,
	type ProcessView,
	processGone,
	type WindowHost,
	WindowId,
	type WindowSlot,
} from "./host.ts";
import {rendererFor, resolverFromTable, windowRenderer} from "./renderer.ts";

type Chat = {readonly messages: ReadonlyArray<string>};
type ChatMsg = {readonly type: "say"; readonly text: string};
type Scroll = {readonly scroll: number};

const pid = ProcessId.make("proc-1");
const top = WindowId.make("win-top");
const bottom = WindowId.make("win-bottom");

const current = <S>(view: Stream.Stream<ProcessView<S>>) =>
	Effect.map(Stream.runHead(view), (head) =>
		Option.getOrThrowWith(head, () => new Error("readProcess emitted nothing")),
	);

describe("window host", () => {
	it.effect("two windows over one process share its state and own separate view slots", () =>
		Effect.gen(function* () {
			const process = yield* testProcess<Chat, ChatMsg>(pid, {messages: []});
			const a = yield* process.window<Scroll>(top, {scroll: 0});
			const b = yield* process.window<Scroll>(bottom, {scroll: 0});

			assert.strictEqual(a.processId, b.processId);
			assert.notStrictEqual(a.windowId, b.windowId);

			// One process: a dispatch through either window moves the state both windows read.
			assert.deepStrictEqual(yield* a.dispatch({type: "say", text: "merhaba"}), {
				_tag: "Delivered",
			});
			yield* process.commit({messages: ["merhaba"]});

			const fromA = yield* current(a.readProcess);
			const fromB = yield* current(b.readProcess);
			assert.deepStrictEqual(fromA, fromB);
			assert.deepStrictEqual(fromA, {
				_tag: "Live",
				processId: pid,
				lifecycle: "running",
				revision: 1,
				state: {messages: ["merhaba"]},
			});

			// Two view slots: scrolling one window leaves the other where it was.
			yield* a.setView({scroll: 240});
			assert.deepStrictEqual(a.view(), {scroll: 240});
			assert.deepStrictEqual(b.view(), {scroll: 0});
		}),
	);

	it.effect("a stopped process reads ProcessGone from every window instead of throwing", () =>
		Effect.gen(function* () {
			const process = yield* testProcess<Chat, ChatMsg>(pid, {messages: []});
			const a = yield* process.window<Scroll>(top, {scroll: 0});
			const b = yield* process.window<Scroll>(bottom, {scroll: 0});

			yield* process.stop;

			assert.deepStrictEqual(yield* current(a.readProcess), processGone(pid));
			assert.deepStrictEqual(yield* current(b.readProcess), processGone(pid));
			// A dispatch after the stop answers with the same value, and never reaches the process.
			assert.deepStrictEqual(yield* a.dispatch({type: "say", text: "geç kaldı"}), processGone(pid));
			assert.deepStrictEqual(process.inbox(), []);
		}),
	);

	it.effect("readProcess replays the current state to a window opened after the change", () =>
		Effect.gen(function* () {
			const process = yield* testProcess<Chat, ChatMsg>(pid, {messages: []});
			yield* process.commit({messages: ["önce"]});
			const late = yield* process.window<Scroll>(top, {scroll: 0});
			const seen = yield* current(late.readProcess);
			assert.deepStrictEqual(seen, {
				_tag: "Live",
				processId: pid,
				lifecycle: "running",
				revision: 1,
				state: {messages: ["önce"]},
			});
		}),
	);
});

describe("the two fallbacks are values", () => {
	it("Empty and ProcessGone are matched, not caught", () => {
		const slots: ReadonlyArray<WindowSlot> = [empty, processGone(pid)];
		const rendered = slots.map((slot) => {
			if (isEmpty(slot)) return "picker";
			if (isProcessGone(slot)) return `placeholder:${slot.processId}`;
			return "renderer";
		});
		assert.deepStrictEqual(rendered, ["picker", "placeholder:proc-1"]);
	});
});

describe("renderer resolution", () => {
	it("a program row's renderer reference resolves to the WindowRenderer it names", () => {
		const counter = windowRenderer(
			"host-native",
			(host: WindowHost<Chat, ChatMsg, Scroll>) => `scroll:${host.view().scroll}`,
		);
		const resolve = resolverFromTable({"tuval/counter": counter});
		const resolution = rendererFor(counterRow, resolve);
		assert.strictEqual(resolution._tag, "Resolved");
		if (resolution._tag !== "Resolved") return;
		assert.strictEqual(resolution.renderer, counter);
	});

	it("a row that declares no renderer answers NoRenderer", () => {
		assert.deepStrictEqual(rendererFor(noRendererRow, resolverFromTable({})), {_tag: "NoRenderer"});
	});

	it("an unknown name and a mismatched kind are both refused as values", () => {
		const counter = windowRenderer("isolated-frame", () => "framed");
		assert.deepStrictEqual(rendererFor(counterRow, resolverFromTable({})), {
			_tag: "RendererUnresolved",
			ref: {kind: "host-native", ref: "tuval/counter"},
			reason: "unknown-ref",
		});
		assert.deepStrictEqual(rendererFor(counterRow, resolverFromTable({"tuval/counter": counter})), {
			_tag: "RendererUnresolved",
			ref: {kind: "host-native", ref: "tuval/counter"},
			reason: "kind-mismatch",
		});
	});
});
