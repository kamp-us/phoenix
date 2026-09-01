/**
 * The correction line: which recorded event it may supersede, and what the fold does with it.
 *
 * The ledger fixture is the shape #7433 reports — four events ending in the ship stage's `DONE`,
 * written before ADR 0343's `partial` field existed.
 */
import {describe, expect, it} from "vitest";
import {coderWorkflow} from "./fixtures.test-support.ts";
import {applyCorrections, deriveStatus, foldLog, type LogEntry, parseLog} from "./fold.ts";
import {type CompiledLane, compile} from "./machine.ts";
import {correctionEntry, findMisroute, pullNumberIn} from "./reconcile.ts";

const lane = (): CompiledLane => {
	const result = compile(coderWorkflow());
	if (result._tag !== "Compiled") throw new Error(result.defects.join("; "));
	return result.lane;
};

const at = (n: number): string => `2026-08-29T23:1${n}:00.000Z`;

const entry = (event: string, when: string, extra: Partial<LogEntry> = {}): LogEntry => ({
	task: "issue",
	event: `ISSUE.${event}`,
	at: when,
	...extra,
});

/** queued → build → review → ship → shipped, the ship `DONE` carrying whatever a caller hands it. */
const shipped = (ship: Partial<LogEntry> = {}): ReadonlyArray<LogEntry> => [
	entry("WIP", at(0)),
	entry("DONE", at(1)),
	entry("PASS", at(2)),
	entry("DONE", at(3), ship),
];

const stateOf = (entries: ReadonlyArray<LogEntry>): string => {
	const compiled = lane();
	const folded = foldLog(compiled, entries);
	if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));
	const status = deriveStatus(compiled, folded.states);
	return typeof status.stateValue === "string"
		? status.stateValue
		: JSON.stringify(status.stateValue);
};

describe("findMisroute", () => {
	it("nominates the ship DONE a pre-0343 ledger recorded with no closure answer", () => {
		const pr = "https://github.com/kamp-us/phoenix/pull/7328";
		const found = findMisroute(lane(), shipped({pr}));
		expect(found).toEqual({
			_tag: "Correctable",
			task: "issue",
			at: at(3),
			state: "ship",
			event: "DONE",
			pr,
		});
	});

	it("carries no PR where the line named none, rather than one from elsewhere in the log", () => {
		expect(findMisroute(lane(), shipped())).toMatchObject({pr: null});
	});

	it("nominates nothing once that DONE carries its answer", () => {
		expect(findMisroute(lane(), shipped({partial: true}))._tag).toBe("Settled");
	});

	it("nominates nothing on a log that never reached a merge-closure guard", () => {
		expect(findMisroute(lane(), shipped().slice(0, 3))._tag).toBe("Settled");
	});

	it("nominates the latest such DONE, so a lane that already went round is not re-routed", () => {
		const log = [
			...shipped({partial: true}),
			entry("WIP", at(4)),
			entry("DONE", at(5)),
			entry("PASS", at(6)),
			entry("DONE", at(7)),
		];
		const found = findMisroute(lane(), log);
		expect(found).toMatchObject({_tag: "Correctable", at: at(7)});
	});

	it("reads a correction already in the log, so a swept lane is not swept twice", () => {
		const log = [...shipped(), correctionEntry("issue", at(3), at(8))];
		expect(findMisroute(lane(), log)._tag).toBe("Settled");
	});
});

describe("the correction line", () => {
	it("sends a lane the board proved partial back to a state an operator can spawn against", () => {
		const log = shipped();
		expect(stateOf(log)).toBe("complete");
		expect(stateOf([...log, correctionEntry("issue", at(3), at(8))])).toBe(
			JSON.stringify({pipeline: {issue: "queued"}}),
		);
	});

	it("leaves a lane whose merge closed its issue folding to complete", () => {
		// No correction is appended on that arm at all — the closure read is what decides, and this
		// pins that the untouched ledger's own fold is unchanged by the field's existence.
		expect(stateOf(shipped())).toBe("complete");
		expect(stateOf(shipped({partial: false}))).toBe("complete");
	});

	it("rewrites no recorded line — the correction is appended and the target stays verbatim", () => {
		const log = [...shipped(), correctionEntry("issue", at(3), at(8))];
		expect(log[3]).toEqual(entry("DONE", at(3)));
		expect(log).toHaveLength(5);
	});

	it("supersedes the entry it names and drops itself before the machine sees it", () => {
		const resolved = applyCorrections([...shipped(), correctionEntry("issue", at(3), at(8))]);
		expect(resolved).toEqual({
			_tag: "Corrected",
			entries: [...shipped().slice(0, 3), entry("DONE", at(3), {partial: true})],
		});
	});

	it("is undecidable rather than resolved when it names no entry of its task", () => {
		const resolved = applyCorrections([...shipped(), correctionEntry("issue", at(9), at(8))]);
		expect(resolved._tag).toBe("Undecidable");
	});

	it("is undecidable rather than resolved when two entries share the timestamp it names", () => {
		const log = [entry("WIP", at(0)), entry("DONE", at(0)), correctionEntry("issue", at(0), at(8))];
		expect(applyCorrections(log)._tag).toBe("Undecidable");
	});

	it("makes an unresolvable correction a fold defect, never a silently skipped line", () => {
		const folded = foldLog(lane(), [...shipped(), correctionEntry("issue", at(9), at(8))]);
		expect(folded._tag).toBe("Unreplayable");
	});
});

describe("pullNumberIn", () => {
	it("reads the number off the ref a lane event carries", () => {
		expect(pullNumberIn("https://github.com/kamp-us/phoenix/pull/7328")).toBe(7328);
		expect(pullNumberIn("https://github.com/kamp-us/phoenix/pull/7328#issuecomment-1")).toBe(7328);
	});

	it("reads a ref that names no PR as no evidence rather than as a number to guess at", () => {
		expect(pullNumberIn(null)).toBeNull();
		expect(pullNumberIn("https://github.com/kamp-us/phoenix/issues/7328")).toBeNull();
		expect(pullNumberIn("pull/seven")).toBeNull();
	});
});

describe("parseLog on a correction", () => {
	const parsed = (line: object) => parseLog(`${JSON.stringify(line)}\n`);

	it("reads the line lane reconcile writes", () => {
		expect(parsed(correctionEntry("issue", at(3), at(8)))).toEqual({
			_tag: "Parsed",
			entries: [correctionEntry("issue", at(3), at(8))],
		});
	});

	it("refuses a correction naming no target", () => {
		const result = parsed({task: "issue", event: "ISSUE.CORRECTED", at: at(8), partial: true});
		expect(result._tag).toBe("Malformed");
	});

	it("refuses a correction carrying no payload to put on its target", () => {
		const result = parsed({task: "issue", event: "ISSUE.CORRECTED", at: at(8), corrects: at(3)});
		expect(result._tag).toBe("Malformed");
	});

	it("refuses `corrects` bolted onto an event that supersedes nothing", () => {
		const result = parsed({task: "issue", event: "ISSUE.DONE", at: at(8), corrects: at(3)});
		expect(result._tag).toBe("Malformed");
	});
});
