/**
 * A `kind: "module"` renderer reference, through the real seam (ADR 0359): the loader the page runs
 * over the generated loaders, feeding the table the resolver reads. The module under test is the
 * in-tree fixture `../demo/module-window.tsx`, loaded by the same `import()` the generated module
 * would carry. Every failure below is a value the resolver reports, never a throw.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import * as fixture from "../demo/module-window.tsx";
import type {RendererRef} from "../registry/program.ts";
import {counterRow} from "../shell/window/fixtures.ts";
import {rendererFor, resolverFromTable, windowRenderer} from "../shell/window/index.ts";
import {loadModuleRenderers} from "./module-renderers.ts";

const MODULE_REF = "/src/demo/module-window.tsx";
const moduleRef: RendererRef = {kind: "module", ref: MODULE_REF};
const loadFixture = () => import("../demo/module-window.tsx");

const rowWith = (renderer: RendererRef) => ({...counterRow, renderer});

describe("a module renderer reference", () => {
	it.effect("resolves to the module's default export, admitted by the module's own predicate", () =>
		Effect.gen(function* () {
			const loaded = yield* loadModuleRenderers({[MODULE_REF]: loadFixture});
			const resolution = rendererFor(rowWith(moduleRef), resolverFromTable(loaded));
			assert.strictEqual(resolution._tag, "Resolved");
			if (resolution._tag !== "Resolved") return;
			assert.strictEqual(resolution.renderer.kind, "module");
			// The seat holds a `ReadableRenderer` over the module's export: the guard `readsState`
			// mints, carrying the module's predicate, and the module's renderer inside it.
			const entry = loaded[MODULE_REF];
			assert.ok(entry !== undefined && "renderer" in entry);
			if (entry === undefined || !("renderer" in entry)) return;
			assert.strictEqual(entry.renderer, fixture.default);
			assert.strictEqual(entry.admits, fixture.admits);
			assert.strictEqual(entry.admits({count: 3}), true);
			assert.strictEqual(entry.admits({lines: []}), false);
		}),
	);

	it.effect(
		"an unknown reference is still unknown-ref: loading modules adds seats, it does not widen them",
		() =>
			Effect.gen(function* () {
				const loaded = yield* loadModuleRenderers({[MODULE_REF]: loadFixture});
				const other: RendererRef = {kind: "module", ref: "@nobody/nothing/window"};
				assert.deepStrictEqual(rendererFor(rowWith(other), resolverFromTable(loaded)), {
					_tag: "RendererUnresolved",
					ref: other,
					reason: "unknown-ref",
				});
			}),
	);

	it.effect(
		"a host-native reference to a loaded module is a kind mismatch, and so is the reverse",
		() =>
			Effect.gen(function* () {
				const loaded = yield* loadModuleRenderers({[MODULE_REF]: loadFixture});
				const asNative: RendererRef = {kind: "host-native", ref: MODULE_REF};
				assert.deepStrictEqual(rendererFor(rowWith(asNative), resolverFromTable(loaded)), {
					_tag: "RendererUnresolved",
					ref: asNative,
					reason: "kind-mismatch",
				});
				const table = {[MODULE_REF]: windowRenderer("host-native", () => "native")};
				assert.deepStrictEqual(rendererFor(rowWith(moduleRef), resolverFromTable(table)), {
					_tag: "RendererUnresolved",
					ref: moduleRef,
					reason: "kind-mismatch",
				});
			}),
	);

	it.effect(
		"a module that throws while loading is a module-load-failed value naming the throw",
		() =>
			Effect.gen(function* () {
				const loaded = yield* loadModuleRenderers({
					[MODULE_REF]: () => Promise.reject(new Error("Cannot find module")),
				});
				assert.deepStrictEqual(rendererFor(rowWith(moduleRef), resolverFromTable(loaded)), {
					_tag: "RendererUnresolved",
					ref: moduleRef,
					reason: "module-load-failed",
					detail: `${MODULE_REF}: the module threw while loading: Cannot find module`,
				});
			}),
	);

	it.effect("a module missing either export, or exporting the wrong kind, is refused by name", () =>
		Effect.gen(function* () {
			const native = windowRenderer("host-native", () => "native");
			const loaded = yield* loadModuleRenderers({
				"no-default": () => Promise.resolve({admits: () => true}),
				"no-admits": () => Promise.resolve({default: windowRenderer("module", () => null)}),
				"wrong-kind": () => Promise.resolve({default: native, admits: () => true}),
				"not-an-object": () => Promise.resolve(null),
			});
			const detailOf = (ref: string): string | undefined => {
				const resolution = resolverFromTable(loaded)({kind: "module", ref});
				return resolution._tag === "RendererUnresolved" ? resolution.detail : undefined;
			};
			assert.match(detailOf("no-default") ?? "", /no default export that is a window renderer/);
			assert.match(detailOf("no-admits") ?? "", /no admits export/);
			assert.match(detailOf("wrong-kind") ?? "", /is a host-native renderer/);
			assert.match(detailOf("not-an-object") ?? "", /not an object/);
		}),
	);

	it.effect("no loaders is an empty table, so a page with no module rows resolves as before", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* loadModuleRenderers({}), {});
		}),
	);
});
