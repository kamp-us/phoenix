/**
 * The renderer reference is type-checked, not just spelled: a renderer written against another
 * program's host cannot stand where this program's is required, and a reference asking for another
 * renderer kind is refused at resolution.
 *
 * The first half is proven by `tsc`, not by a runtime assertion. Each `@ts-expect-error` below is
 * the assertion — the checker fails the build if the line it marks ever stops erroring, which is
 * exactly "a mismatched renderer is refused" stated so it cannot rot (`.patterns/effect-testing.md`
 * on tests that must be wrong loudly).
 */

import {describe, expect, it} from "vitest";
import type {ViewState, WindowHost} from "../../../shell/window/host.ts";
import {
	rendererFor,
	resolverFromTable,
	type WindowRenderer,
	windowRenderer,
} from "../../../shell/window/renderer.ts";
import {ENGINE_VIEW_RENDERER_REF, engineViewProgram} from "../program.ts";
import {engineViewRenderer} from "./renderer.tsx";

type CounterState = {readonly count: number};
type CounterMsg = {readonly type: "tick"};

const counterRenderer = windowRenderer(
	"host-native",
	(_host: WindowHost<CounterState, CounterMsg, ViewState>) => null,
);

/** What the engine-view row's reference has to resolve to. */
type EngineViewWindowRenderer = typeof engineViewRenderer;

// @ts-expect-error a renderer over another program's state and Msg is not this program's renderer.
const foreign: EngineViewWindowRenderer = counterRenderer;

// @ts-expect-error and the refusal is symmetric: this program's renderer is not the counter's either.
const backwards: typeof counterRenderer = engineViewRenderer;

describe("engine-view: the renderer its row names", () => {
	it("resolves through the row's reference", () => {
		const resolve = resolverFromTable({[ENGINE_VIEW_RENDERER_REF]: engineViewRenderer});
		const resolution = rendererFor(engineViewProgram(), resolve);
		expect(resolution._tag).toBe("Resolved");
	});

	it("refuses a renderer registered under the row's name at another kind", () => {
		const mismatched: WindowRenderer<null> = windowRenderer("isolated-frame", () => null);
		const resolve = resolverFromTable({[ENGINE_VIEW_RENDERER_REF]: mismatched});
		expect(rendererFor(engineViewProgram(), resolve)).toEqual({
			_tag: "RendererUnresolved",
			ref: {kind: "host-native", ref: ENGINE_VIEW_RENDERER_REF},
			reason: "kind-mismatch",
		});
	});

	it("refuses a reference no table holds", () => {
		expect(rendererFor(engineViewProgram(), resolverFromTable({}))).toEqual({
			_tag: "RendererUnresolved",
			ref: {kind: "host-native", ref: ENGINE_VIEW_RENDERER_REF},
			reason: "unknown-ref",
		});
	});

	it("keeps the two refused bindings above referenced, so nothing prunes the proof", () => {
		expect([foreign, backwards].length).toBe(2);
	});
});
