/**
 * The registry row and the renderer it names — at the type level and at the resolver.
 *
 * The type-level half is written both ways on purpose (`.patterns/unconditional-test-assertions.md`,
 * "the type-level sibling"): the positive arm binds, and the negative arm is the flip that proves
 * the positive one was not vacuous. A renderer over another program's state must not satisfy this
 * program's renderer type, or `windowRenderer`'s whole inference story buys nothing.
 */

import type {ReactNode} from "react";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {AnyWindowRenderer, ViewState, WindowRenderer} from "../../shell/window/index.ts";
import {rendererFor, resolverFromTable, windowRenderer} from "../../shell/window/index.ts";
import {PS_RENDERER_REF, psId, psProgram, psRendererRef} from "./program.ts";
import {psReactRenderer, psWindowRenderer} from "./renderer.tsx";
import type {PsMsg, PsState} from "./state.ts";

type PsRenderer = WindowRenderer<ReactNode, PsState, PsMsg, ViewState>;
type ForeignState = {readonly count: number};

describe("the ps registry row", () => {
	it("is the row shape, carrying a renderer reference", () => {
		expect(String(psProgram.id)).toBe("ps");
		expect(String(psId)).toBe("ps");
		expect(psProgram.renderer).toEqual({kind: "host-native", ref: PS_RENDERER_REF});
		expect(psProgram.ports).toEqual({});
		expect(psProgram.placement).toEqual({host: "local"});
	});

	it("resolves to this program's renderer through the shell's table", () => {
		const resolution = rendererFor(
			psProgram,
			resolverFromTable({[PS_RENDERER_REF]: psWindowRenderer as AnyWindowRenderer}),
		);
		expect(resolution).toEqual({_tag: "Resolved", renderer: psWindowRenderer});
	});

	it("refuses a table entry whose kind disagrees with the row's reference", () => {
		const mismatched = windowRenderer<ReactNode, PsState, PsMsg, ViewState>(
			"isolated-frame",
			() => null,
		);
		const resolution = rendererFor(
			psProgram,
			resolverFromTable({[PS_RENDERER_REF]: mismatched as AnyWindowRenderer}),
		);
		expect(resolution).toEqual({
			_tag: "RendererUnresolved",
			ref: psRendererRef,
			reason: "kind-mismatch",
		});
	});

	it("refuses a table that holds no entry for the reference", () => {
		expect(rendererFor(psProgram, resolverFromTable({}))).toEqual({
			_tag: "RendererUnresolved",
			ref: psRendererRef,
			reason: "unknown-ref",
		});
	});
});

describe("the ps window renderer, at the type level", () => {
	it("is a renderer over this program's state and Msg", () => {
		expectTypeOf(psWindowRenderer).toExtend<PsRenderer>();
		expectTypeOf(psWindowRenderer.kind).toEqualTypeOf<
			"host-native" | "host-declarative" | "isolated-frame"
		>();
		expectTypeOf(psReactRenderer).toBeFunction();
	});

	it("refuses a renderer written against another program's host", () => {
		expectTypeOf<
			WindowRenderer<ReactNode, ForeignState, PsMsg, ViewState>
		>().not.toExtend<PsRenderer>();
		expectTypeOf<
			WindowRenderer<ReactNode, PsState, {readonly type: "tick"}, ViewState>
		>().not.toExtend<PsRenderer>();
	});
});
