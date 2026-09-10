/**
 * The Snapshot test double the composition selectors are driven against. It exists so the selectors
 * can be proven without a kernel, a socket or a surface — the same reason `../window/fixtures.ts`
 * exists, and it borrows that module's `testProcess` for the one live host a renderer mounts into,
 * so the host these tests pass is the host the contract actually promises.
 */

import {Effect} from "effect";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {testProcess} from "../window/fixtures.ts";
import type {AnyWindowHost} from "../window/host.ts";
import {WindowId} from "../window/host.ts";
import type {DeskSnapshot, FocusedWindow} from "./snapshot.ts";

export interface CounterState {
	readonly count: number;
}

export type CounterMsg = {readonly type: "tick"};

export const focusedWindowId = WindowId.make("window-1");
export const counterProcessId = ProcessId.make("process-1");
export const counterProgramId = ProgramId.make("counter");

/** A live host over one in-memory counter process, at the window the desk focuses. */
export const testHost = (count = 0): Effect.Effect<AnyWindowHost> =>
	Effect.gen(function* () {
		const process = yield* testProcess<CounterState, CounterMsg>(counterProcessId, {count});
		return yield* process.window(focusedWindowId, {selected: null});
	});

/** The focused window as the selectors read it: a window, its process and a mounted host. */
export const focusedOn = (host: AnyWindowHost): FocusedWindow => ({
	windowId: focusedWindowId,
	processId: counterProcessId,
	host,
});

/**
 * A snapshot with nothing declared: one focused window over the `counter` program, whose row
 * declares neither renderer. Every test below starts here and overrides the one field it is about.
 */
export const deskSnapshot = (overrides: Partial<DeskSnapshot> = {}): DeskSnapshot => ({
	workspace: "workspace-0",
	kernel: {processes: 1, revision: 7},
	focused: null,
	processes: {[counterProcessId]: {programId: counterProgramId}},
	programs: {[counterProgramId]: {}},
	inspectors: {},
	statuses: {},
	...overrides,
});
