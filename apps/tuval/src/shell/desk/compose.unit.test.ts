/**
 * The two selectors, driven over the Snapshot test double: the whole walk from a focused window to
 * a program's renderer, every step of it that does not resolve, and the composition rule that keeps
 * the bar's left and right the shell's (#7500 rulings 4 and 5).
 */

import {assert, describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import {ProcessId} from "../../process/process.ts";
import type {AnyWindowHost} from "../window/host.ts";
import {WindowId} from "../window/host.ts";
import {inspectorFor, statusFor} from "./compose.ts";
import {counterProgramId, deskSnapshot, focusedOn, testHost} from "./fixtures.ts";
import {inspectorRenderer, statusRenderer} from "./renderer.ts";
import type {DeskSnapshot} from "./snapshot.ts";

interface Selection {
	readonly selected: string | null;
}

const inspector = inspectorRenderer("host-native", (host: AnyWindowHost) => ({
	panel: `inspecting ${host.windowId}`,
}));

const status = statusRenderer("host-native", (host: AnyWindowHost) => [
	{id: "mode", text: "normal"},
	{id: "window", text: String(host.windowId)},
]);

/** A desk whose focused window runs a program declaring both renderers, both resolvable. */
const declaredDesk = (host: AnyWindowHost, overrides: Partial<DeskSnapshot> = {}): DeskSnapshot =>
	deskSnapshot({
		focused: focusedOn(host),
		programs: {
			[counterProgramId]: {
				inspector: {kind: "host-native", ref: "counter/inspector"},
				status: {kind: "host-native", ref: "counter/status"},
			},
		},
		inspectors: {"counter/inspector": inspector},
		statuses: {"counter/status": status},
		...overrides,
	});

describe("inspectorFor", () => {
	it.effect("resolves the focused window's program renderer and the host it mounts into", () =>
		Effect.gen(function* () {
			const host = yield* testHost();
			const region = inspectorFor(declaredDesk(host));
			assert.strictEqual(region._tag, "Inspector");
			const rendered =
				region._tag === "Inspector" ? region.renderer.render(region.host) : {panel: "unreached"};
			assert.deepStrictEqual(rendered, {panel: "inspecting window-1"});
		}),
	);

	it.effect("answers the typed empty case at every step of the walk that does not resolve", () =>
		Effect.gen(function* () {
			const host = yield* testHost();
			const reasonOf = (snapshot: DeskSnapshot): string => {
				const region = inspectorFor(snapshot);
				return region._tag === "NoInspector" ? region.reason : "resolved";
			};

			assert.deepStrictEqual(
				[
					reasonOf(deskSnapshot({focused: null})),
					reasonOf(
						deskSnapshot({
							focused: {windowId: WindowId.make("window-1"), processId: null, host: null},
						}),
					),
					reasonOf(deskSnapshot({focused: focusedOn(host), processes: {}})),
					reasonOf(deskSnapshot({focused: focusedOn(host), programs: {}})),
					reasonOf(deskSnapshot({focused: focusedOn(host)})),
					reasonOf(declaredDesk(host, {inspectors: {}})),
					reasonOf(
						declaredDesk(host, {
							inspectors: {"counter/inspector": {...inspector, kind: "isolated-frame"}},
						}),
					),
				],
				[
					"no-focused-window",
					"window-unbound",
					"process-unknown",
					"program-unknown",
					"not-declared",
					"unknown-ref",
					"kind-mismatch",
				],
			);
		}),
	);

	it.effect("does not throw on a program that declares no inspector", () =>
		Effect.gen(function* () {
			const host = yield* testHost();
			const region = inspectorFor(deskSnapshot({focused: focusedOn(host)}));
			assert.deepStrictEqual(region, {_tag: "NoInspector", reason: "not-declared"});
		}),
	);
});

describe("statusFor", () => {
	it.effect(
		"puts the program's segments in the middle and composes the shell's own two sides",
		() =>
			Effect.gen(function* () {
				const host = yield* testHost();
				const bar = statusFor(declaredDesk(host));
				assert.deepStrictEqual(bar.left, [{id: "workspace", text: "workspace-0"}]);
				assert.deepStrictEqual(bar.middle, [
					{id: "mode", text: "normal"},
					{id: "window", text: "window-1"},
				]);
				assert.deepStrictEqual(bar.right, [
					{id: "processes", text: "1 process"},
					{id: "revision", text: "rev 7"},
				]);
				assert.strictEqual(bar.middleEmpty, null);
			}),
	);

	it.effect("a program cannot write the left or the right, whatever segments it returns", () =>
		Effect.gen(function* () {
			const host = yield* testHost();
			const greedy = statusRenderer("host-native", () => [
				{id: "workspace", text: "hijacked"},
				{id: "processes", text: "hijacked"},
				{id: "revision", text: "hijacked"},
			]);
			const shellOnly = statusFor(deskSnapshot({focused: focusedOn(host)}));
			const withProgram = statusFor(declaredDesk(host, {statuses: {"counter/status": greedy}}));

			assert.deepStrictEqual(withProgram.left, shellOnly.left);
			assert.deepStrictEqual(withProgram.right, shellOnly.right);
			assert.deepStrictEqual(
				withProgram.middle.map((segment) => segment.text),
				["hijacked", "hijacked", "hijacked"],
			);
		}),
	);

	it.effect("leaves the middle empty and says why when no program fills it", () =>
		Effect.gen(function* () {
			const host = yield* testHost();
			const bar = statusFor(deskSnapshot({focused: focusedOn(host)}));
			assert.deepStrictEqual(bar.middle, []);
			assert.strictEqual(bar.middleEmpty, "not-declared");
			assert.deepStrictEqual(bar.left, [{id: "workspace", text: "workspace-0"}]);
			assert.strictEqual(statusFor(deskSnapshot({focused: null})).middleEmpty, "no-focused-window");
		}),
	);

	it.effect("reads the program's own selection state out of the host's view slot", () =>
		Effect.gen(function* () {
			const host = yield* testHost();
			yield* host.setView({selected: "node-4"});
			const selecting = statusRenderer("host-native", (mounted: AnyWindowHost) => [
				{id: "selected", text: String((mounted.view() as Selection).selected)},
			]);
			const bar = statusFor(declaredDesk(host, {statuses: {"counter/status": selecting}}));
			assert.deepStrictEqual(bar.middle, [{id: "selected", text: "node-4"}]);
		}),
	);

	it("counts a desk with no process as unbound rather than resolving a stale program", () => {
		const bar = statusFor(
			deskSnapshot({
				focused: {
					windowId: WindowId.make("window-1"),
					processId: ProcessId.make("process-9"),
					host: null,
				},
			}),
		);
		expect(bar.middleEmpty).toBe("window-unbound");
		expect(bar.middle).toEqual([]);
	});
});
