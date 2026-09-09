/**
 * The subagent slot's admission test: the seven fields it carries, and what each of them refuses.
 *
 * The `items` arm is the one worth a case of its own. A worker's inbound turn arrives
 * parent-tagged like everything else it produces, so the slot admits every item kind rather than
 * the assistant, thinking and tool ones — a slot that refused a `user` row would drop the operator's
 * own instruction out of the view Q7 switches to (#8384).
 */

import {describe, expect, it} from "vitest";
import {
	assistantItem,
	compactionItem,
	subagentSlot,
	systemItem,
	thinkingItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import {isSubagentSlot, isSubagentSlots} from "./subagent.ts";

const slot = subagentSlot("call-1");

describe("a subagent slot", () => {
	it("is admitted with the six reported fields and the id it is keyed on", () => {
		expect(isSubagentSlot(slot)).toBe(true);
		expect(Object.keys(slot).sort()).toEqual([
			"id",
			"items",
			"lastLine",
			"startedAt",
			"status",
			"tokens",
			"type",
			"workers",
		]);
	});

	it("refuses each field carrying the wrong type", () => {
		expect(isSubagentSlot({...slot, id: 7})).toBe(false);
		expect(isSubagentSlot({...slot, id: ""})).toBe(false);
		expect(isSubagentSlot({...slot, type: {name: "general-purpose"}})).toBe(false);
		// An unnamed worker and a worker named "" are different facts, and only the first is a slot.
		expect(isSubagentSlot({...slot, type: null})).toBe(true);
		expect(isSubagentSlot({...slot, type: ""})).toBe(false);
		expect(isSubagentSlot({...slot, lastLine: null})).toBe(false);
		expect(isSubagentSlot({...slot, startedAt: "2026-09-07"})).toBe(false);
		expect(isSubagentSlot({...slot, startedAt: Number.NaN})).toBe(false);
		expect(isSubagentSlot({...slot, tokens: -1})).toBe(false);
		expect(isSubagentSlot({...slot, tokens: 1.5})).toBe(false);
		expect(isSubagentSlot({...slot, tokens: "340k"})).toBe(false);
		// A slot is of at least one worker, so zero is not a count and neither is an absent one.
		expect(isSubagentSlot({...slot, workers: 3})).toBe(true);
		expect(isSubagentSlot({...slot, workers: 0})).toBe(false);
		expect(isSubagentSlot({...slot, workers: -1})).toBe(false);
		expect(isSubagentSlot({...slot, workers: 1.5})).toBe(false);
		expect(isSubagentSlot({...slot, workers: "3 workers"})).toBe(false);
		expect(isSubagentSlot({...slot, workers: undefined})).toBe(false);
		expect(isSubagentSlot({...slot, items: [{kind: "user"}]})).toBe(false);
		expect(isSubagentSlot({...slot, items: {}})).toBe(false);
		expect(isSubagentSlot({...slot, status: "done"})).toBe(false);
		expect(isSubagentSlot({...slot, status: true})).toBe(false);
		expect(isSubagentSlot("call-1")).toBe(false);
		expect(isSubagentSlot(null)).toBe(false);
	});

	// The two facts one field carries: a kernel child names its process, a harness-native worker
	// names none. An empty string is neither, and a checkpoint written before the field existed is
	// the second one rather than corruption.
	it("admits a slot naming the process it is for, and refuses one naming an empty string", () => {
		expect(isSubagentSlot({...slot, process: "p-9"})).toBe(true);
		expect(Object.keys({...slot, process: "p-9"}).sort()).toContain("process");
		expect(isSubagentSlot({...slot, process: ""})).toBe(false);
		expect(isSubagentSlot({...slot, process: 7})).toBe(false);
		expect(isSubagentSlot({...slot, process: null})).toBe(false);
	});

	it("admits every item kind in its rows, not the agent-facing three", () => {
		const items = [
			userItem("u1"),
			assistantItem("a1"),
			thinkingItem("t1"),
			toolItem("c1"),
			systemItem("s1"),
			compactionItem("k1"),
		];
		expect(isSubagentSlot(subagentSlot("call-1", {items}))).toBe(true);
	});

	it("is finished as well as running, so a worker that ended is still representable", () => {
		expect(isSubagentSlot(subagentSlot("call-1", {status: "finished"}))).toBe(true);
	});
});

describe("the slots one agent holds", () => {
	it("admits an empty set and a keyed one, and refuses a bad row in it", () => {
		expect(isSubagentSlots({})).toBe(true);
		expect(isSubagentSlots({"call-1": slot, "call-2": subagentSlot("call-2")})).toBe(true);
		expect(isSubagentSlots({"call-1": {...slot, tokens: -1}})).toBe(false);
		expect(isSubagentSlots([slot])).toBe(false);
	});
});
