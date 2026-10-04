/**
 * The lane fold's no-cell contract, pinned against the exact `@demlik/tea` the CLI resolves.
 *
 * `@demlik/tea` 0.18.0 changed its *runtime* so a Msg with no cell rejects that one dispatch and keeps
 * the run alive, where it used to halt the run. The lane fold is not a runtime: it replays a ledger
 * through tea's pure `foldMsgs` / `applyCell`, which still throw `NoCellError`, and a ledger line
 * with no cell is a hand edit the fold refuses whole. Skipping that line and folding on — the
 * runtime's new reading — would let a doctored ledger derive a state nobody recorded. These
 * assertions hold the full result, so a tea bump that moves the pure path onto the runtime's
 * semantics reds here instead of silently changing what a lane folds to.
 */
import {describe, expect, it} from "vitest";
import {twoPhaseWorkflow} from "./fixtures.test-support.ts";
import {applyEvent, foldLog, type LogEntry, walkOf} from "./fold.ts";
import {type CompiledLane, compile} from "./machine.ts";

const AT = "2026-08-16T00:00:00.000Z";

const compiled = (): CompiledLane => {
	const result = compile(twoPhaseWorkflow());
	if (result._tag !== "Compiled") throw new Error(result.defects.join("; "));
	return result.lane;
};

const entry = (task: string, event: string): LogEntry => ({
	task,
	event: `${task.toUpperCase()}.${event}`,
	at: AT,
});

describe("a ledger event with no matching cell (NoCellError)", () => {
	it("refuses the whole log rather than skipping the line and folding on", () => {
		const lane = compiled();

		const fold = foldLog(lane, [
			entry("task_b", "DONE"),
			entry("task_a", "PASS"),
			entry("task_a", "DONE"),
		]);

		expect(fold).toEqual({
			_tag: "Unreplayable",
			defects: [
				'task "task_a": the log does not replay — @demlik/tea: no update cell for msg.type "PASS" in state "doing" — the machine\'s update does not handle this Msg (an unknown wire msg.type, or a missing cell reached by bypassing the mapped types). This state accepts: "DONE", "BLOCKED", "CLEARED", "CANCELLED", "LANDED".',
			],
		});
	});

	it("walks to NoCell and appends nothing for an event the current state holds no cell for", () => {
		const lane = compiled();
		const fold = foldLog(lane, [entry("task_a", "DONE")]);
		if (fold._tag !== "Folded")
			throw new Error(`fixture log does not fold: ${fold.defects.join("; ")}`);
		expect(fold.states.task_a?.type).toBe("checking");

		expect(walkOf(lane, fold.states, "task_a", "DONE", null)).toEqual({
			_tag: "NoCell",
			why: '"checking" holds no cell for "DONE" — it walks BLOCKED/CANCELLED/CLEARED/FAIL/LANDED/PASS alone',
		});
		expect(applyEvent(lane, fold.states, "task_a", "DONE", AT)).toEqual({
			_tag: "Refused",
			kind: "event",
			reason:
				'NoCellError: @demlik/tea: no update cell for msg.type "DONE" in state "checking" — the machine\'s update does not handle this Msg (an unknown wire msg.type, or a missing cell reached by bypassing the mapped types). This state accepts: "PASS", "BLOCKED", "FAIL", "CLEARED", "CANCELLED", "LANDED".',
		});
	});
});
