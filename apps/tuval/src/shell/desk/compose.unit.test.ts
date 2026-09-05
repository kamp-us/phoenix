/**
 * The two selectors, driven over the Snapshot test double: the whole walk from a focused window to
 * a program's renderer, every step of it that does not resolve, and the composition rule that keeps
 * the bar's left and right the shell's (#7500 rulings 4 and 5).
 */

import {Effect} from "effect";
import {describe, expect, it} from "vitest";
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
	it("resolves the focused window's program renderer and the host it mounts into", async () => {
		const host = await Effect.runPromise(testHost());
		const region = inspectorFor(declaredDesk(host));
		expect(region._tag).toBe("Inspector");
		const rendered =
			region._tag === "Inspector" ? region.renderer.render(region.host) : {panel: "unreached"};
		expect(rendered).toEqual({panel: "inspecting window-1"});
	});

	it("answers the typed empty case at every step of the walk that does not resolve", async () => {
		const host = await Effect.runPromise(testHost());
		const reasonOf = (snapshot: DeskSnapshot): string => {
			const region = inspectorFor(snapshot);
			return region._tag === "NoInspector" ? region.reason : "resolved";
		};

		expect([
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
		]).toEqual([
			"no-focused-window",
			"window-unbound",
			"process-unknown",
			"program-unknown",
			"not-declared",
			"unknown-ref",
			"kind-mismatch",
		]);
	});

	it("does not throw on a program that declares no inspector", async () => {
		const host = await Effect.runPromise(testHost());
		const region = inspectorFor(deskSnapshot({focused: focusedOn(host)}));
		expect(region).toEqual({_tag: "NoInspector", reason: "not-declared"});
	});
});

describe("statusFor", () => {
	it("puts the program's segments in the middle and composes the shell's own two sides", async () => {
		const host = await Effect.runPromise(testHost());
		const bar = statusFor(declaredDesk(host));
		expect(bar.left).toEqual([{id: "workspace", text: "workspace-0"}]);
		expect(bar.middle).toEqual([
			{id: "mode", text: "normal"},
			{id: "window", text: "window-1"},
		]);
		expect(bar.right).toEqual([
			{id: "processes", text: "1 process"},
			{id: "revision", text: "rev 7"},
		]);
		expect(bar.middleEmpty).toBeNull();
	});

	it("a program cannot write the left or the right, whatever segments it returns", async () => {
		const host = await Effect.runPromise(testHost());
		const greedy = statusRenderer("host-native", () => [
			{id: "workspace", text: "hijacked"},
			{id: "processes", text: "hijacked"},
			{id: "revision", text: "hijacked"},
		]);
		const shellOnly = statusFor(deskSnapshot({focused: focusedOn(host)}));
		const withProgram = statusFor(declaredDesk(host, {statuses: {"counter/status": greedy}}));

		expect(withProgram.left).toEqual(shellOnly.left);
		expect(withProgram.right).toEqual(shellOnly.right);
		expect(withProgram.middle.map((segment) => segment.text)).toEqual([
			"hijacked",
			"hijacked",
			"hijacked",
		]);
	});

	it("leaves the middle empty and says why when no program fills it", async () => {
		const host = await Effect.runPromise(testHost());
		const bar = statusFor(deskSnapshot({focused: focusedOn(host)}));
		expect(bar.middle).toEqual([]);
		expect(bar.middleEmpty).toBe("not-declared");
		expect(bar.left).toEqual([{id: "workspace", text: "workspace-0"}]);
		expect(statusFor(deskSnapshot({focused: null})).middleEmpty).toBe("no-focused-window");
	});

	it("reads the program's own selection state out of the host's view slot", async () => {
		const host = await Effect.runPromise(testHost());
		await Effect.runPromise(host.setView({selected: "node-4"}));
		const selecting = statusRenderer("host-native", (mounted: AnyWindowHost) => [
			{id: "selected", text: String((mounted.view() as Selection).selected)},
		]);
		const bar = statusFor(declaredDesk(host, {statuses: {"counter/status": selecting}}));
		expect(bar.middle).toEqual([{id: "selected", text: "node-4"}]);
	});

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
