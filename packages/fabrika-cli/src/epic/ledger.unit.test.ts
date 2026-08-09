import {describe, expect, it} from "vitest";
import {ledgerOf, verdictMarkerFor} from "./fixtures.test-support.ts";
import {
	boundShaOf,
	countersFor,
	DEAD_AXIS_CAP,
	FAIL_AXIS_CAP,
	handoffPath,
	nextSeq,
	parseLedger,
	polarityOf,
	runDir,
	runKey,
	trippedAxis,
} from "./ledger.ts";

describe("parseLedger", () => {
	it("reads every well-formed line, in order", () => {
		const read = parseLedger(
			ledgerOf({event: "run-opened"}, {event: "slice-dispatched", slice: "C1", sha: "abc1234"}),
		);
		expect(read._tag).toBe("Ledger");
		if (read._tag !== "Ledger") return;
		expect(read.lines.map((line) => line.event)).toEqual(["run-opened", "slice-dispatched"]);
		expect(read.lines[1]?.sha).toBe("abc1234");
	});

	it("refuses an off-enum event, naming it and its seq — never skipping the line", () => {
		const read = parseLedger(
			`${ledgerOf({event: "run-opened"})}{"seq":14,"at":"","event":"slice-skipped","slice":"C2","detail":null,"sha":null}\n`,
		);
		expect(read._tag).toBe("Unnameable");
		if (read._tag !== "Unnameable") return;
		expect(read.detail).toBe('event "slice-skipped" at seq 14');
	});

	it("refuses a line that is not JSON", () => {
		const read = parseLedger(`${ledgerOf({event: "run-opened"})}not json at all\n`);
		expect(read._tag).toBe("Unnameable");
		if (read._tag !== "Unnameable") return;
		expect(read.detail).toBe("line 2 is not a JSON object");
	});

	it("refuses a seq regression — an out-of-order log is unnameable, not reorderable", () => {
		const read = parseLedger(
			'{"seq":7,"at":"","event":"run-opened","slice":null,"detail":null,"sha":null}\n{"seq":4,"at":"","event":"pr-opened","slice":null,"detail":null,"sha":null}\n',
		);
		expect(read._tag).toBe("Unnameable");
		if (read._tag !== "Unnameable") return;
		expect(read.detail).toBe("seq 4 follows seq 7 at line 2");
	});

	it("reads an empty file as an empty ledger, and seats the next seq at 1", () => {
		const read = parseLedger("");
		expect(read._tag).toBe("Ledger");
		if (read._tag !== "Ledger") return;
		expect(nextSeq(read.lines)).toBe(1);
	});
});

describe("the two counters", () => {
	const failedTwice = parseLedger(
		ledgerOf(
			{event: "slice-dispatched", slice: "C2", sha: "aaaaaaa"},
			{event: "slice-landed", slice: "C2", sha: "bbbbbbb"},
			{
				event: "verdict-recorded",
				slice: "C2",
				detail: verdictMarkerFor("C2", "FAIL", "bbbbbbb", "the parser drops the final row"),
			},
			{event: "retry-injected", slice: "C2"},
			{event: "dispatch-dead", slice: "C1"},
		),
	);

	it("counts the FAIL that OPENS a cycle, and counts dead dispatches on their own axis", () => {
		if (failedTwice._tag !== "Ledger") return;
		expect(countersFor(failedTwice.lines, "C2")).toEqual({failAttempts: 1, deadAttempts: 0});
		expect(countersFor(failedTwice.lines, "C1")).toEqual({failAttempts: 0, deadAttempts: 1});
	});

	it("never sums the axes — one under each cap trips nothing", () => {
		expect(
			trippedAxis({failAttempts: FAIL_AXIS_CAP - 1, deadAttempts: DEAD_AXIS_CAP - 1}),
		).toBeNull();
	});

	it("names the axis that reached its cap", () => {
		expect(trippedAxis({failAttempts: FAIL_AXIS_CAP, deadAttempts: 0})).toBe("fail");
		expect(trippedAxis({failAttempts: 0, deadAttempts: DEAD_AXIS_CAP})).toBe("dead");
	});
});

describe("the recorded marker", () => {
	const line = {
		seq: 1,
		at: "",
		event: "verdict-recorded" as const,
		slice: "C2",
		detail: verdictMarkerFor("C2", "FAIL", "8c1f2a9d", "the parser drops the final row"),
		sha: null,
	};

	it("carries the polarity and the SHA it binds", () => {
		expect(polarityOf(line)).toBe("FAIL");
		expect(boundShaOf(line)).toBe("8c1f2a9d");
	});
});

describe("the run's paths", () => {
	it("keys on the claim nonce, never the session id", () => {
		expect(runKey(4300, "c1a4d6f8")).toBe("4300-c1a4d6f8");
		expect(runDir("/repo/trees/lane-a", "4300-c1a4d6f8")).toBe(
			"/repo/trees/lane-a/.fabrika-epic/4300-c1a4d6f8",
		);
	});

	it("gives each slice its own handoff path, so two dispatches cannot clobber one note", () => {
		expect(handoffPath("/run", "4300-c1a4d6f8", "C1")).toBe(
			"/run/fabrika-epic/4300-c1a4d6f8/C1/handoff.md",
		);
		expect(handoffPath("/run", "4300-c1a4d6f8", "C2")).not.toBe(
			handoffPath("/run", "4300-c1a4d6f8", "C1"),
		);
	});
});
