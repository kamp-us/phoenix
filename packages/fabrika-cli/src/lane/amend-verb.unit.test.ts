/**
 * `lane amend` — the accepted re-derivation, and the three refusals that leave `events.jsonl` byte
 * for byte where they found it.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {issuePayload, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {type AmendOptions, type OwnershipReader, runAmend} from "./amend-verb.ts";
import {
	AMEND_DROPS_LANDED,
	AMEND_UNREPLAYABLE,
	APPEND_UNKNOWN,
	DEFERRAL_REFUSED,
	LANE_UNREADABLE,
	TOPOLOGY_MALFORMED,
} from "./codes.ts";
import {emitMachine} from "./emit.ts";
import {deriveStatus, foldLog, type LogEntry, parseLog} from "./fold.ts";
import {compileText} from "./machine.ts";

const EPIC = 4300;
const ROOT = ".fabrika/lanes";
const DIR = `${ROOT}/${EPIC}`;
const WORKFLOW = `${DIR}/workflow.json`;
const LOG = `${DIR}/events.jsonl`;

const ISSUE = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300$/;
const SUBS = /^GET https:\/\/api\.github\.com\/repos\/o\/r\/issues\/4300\/sub_issues\?/;

const bodyOf = (...lines: ReadonlyArray<string>): string =>
	["## Plan", "", "## Dependencies", "", ...lines].join("\n");

/** The topology the lane on disk was emitted from: two children, one phase. */
const BOOTED = bodyOf("- phase 1: #4301, #4302");

type Link = {
	readonly number: number;
	readonly state: "open" | "closed";
	readonly stateReason: null | string;
};

const open = (...numbers: ReadonlyArray<number>): ReadonlyArray<Link> =>
	numbers.map((number) => ({number, state: "open" as const, stateReason: null}));

const machineText = (body: string, links: ReadonlyArray<Link>): string => {
	const emitted = emitMachine(EPIC, body, links);
	if (emitted._tag !== "Emitted") throw new Error(`fixture did not emit: ${emitted._tag}`);
	return emitted.text;
};

const line = (task: string, event: string, at: string): string =>
	`${JSON.stringify({task, event: `${task.toUpperCase()}.${event}`, at} satisfies LogEntry)}\n`;

const AT = (n: number): string => `2026-09-0${n}T00:00:00.000Z`;
const NOW = "2026-09-10T12:00:00.000Z";

/** No board read at all: every deferral candidate reads as unheld. */
const idleOwnership: OwnershipReader = () => Effect.succeed({_tag: "Idle" as const});

const OPTIONS = {
	epic: EPIC,
	lane: String(EPIC),
	root: ROOT,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
		string,
		string | undefined
	>,
	now: NOW,
	defer: [] as ReadonlyArray<string>,
	deferReason: null as string | null,
	ownership: idleOwnership,
};

const board = (
	body: string,
	links: ReadonlyArray<Link>,
): ReadonlyArray<readonly [RegExp, HttpReply]> => [
	[ISSUE, served(issuePayload({number: EPIC, body}))],
	[
		SUBS,
		{
			status: 200,
			body: JSON.stringify(
				links.map((link) => ({
					number: link.number,
					state: link.state,
					state_reason: link.stateReason,
				})),
			),
		},
	],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, HttpReply]>,
	log: string,
	workflow: string = machineText(BOOTED, open(4301, 4302)),
	overrides: Partial<AmendOptions> = {},
	unwritable: ReadonlyArray<string> = [],
) => {
	const fs = fakeFs({files: {[WORKFLOW]: workflow, [LOG]: log}, directories: [DIR], unwritable});
	return Effect.runPromise(
		Effect.provide(
			runAmend({...OPTIONS, ...overrides}),
			Layer.mergeAll(fs.layer, fakeShell([]).layer, fakeHttp(script).layer),
		),
	).then((out) => ({out, fs}));
};

describe("lane amend", () => {
	it("adds a child to the running topology: the new task boots queued and the log is appended to", async () => {
		const log = line("issue_4301", "WIP", AT(1));
		const {out, fs} = await run(
			board(bodyOf("- phase 1: #4301, #4302", "- phase 2: #4303"), open(4301, 4302, 4303)),
			log,
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "amended",
			epic: EPIC,
			added: ["issue_4303"],
			dropped: [],
			phases: 2,
			children: 3,
		});
		const written = fs.written.get(LOG) ?? "";
		expect(written.startsWith(log)).toBe(true);
		expect(JSON.parse(written.slice(log.length))).toEqual({
			task: "epic_4300",
			event: "EPIC_4300.AMENDED",
			at: NOW,
			tasks: ["issue_4301", "issue_4302", "issue_4303", "epic_4300"],
		});
		const machine = JSON.parse(fs.written.get(WORKFLOW) ?? "{}");
		expect(machine.machine.states.phase2.states.issue_4303.initial).toBe("queued");
	});

	it("re-sequences a not-started child into a later phase and the log still replays", async () => {
		const {out, fs} = await run(
			board(bodyOf("- phase 1: #4301", "- phase 2: #4302"), open(4301, 4302)),
			line("issue_4301", "WIP", AT(1)),
		);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({added: [], dropped: [], phases: 2});
		const machine = JSON.parse(fs.written.get(WORKFLOW) ?? "{}");
		expect(Object.keys(machine.machine.states.phase2.states)).toEqual(["issue_4302"]);
	});

	it("answers `current` and writes nothing when the topology already derives this machine", async () => {
		const log = line("issue_4301", "WIP", AT(1));
		const {out, fs} = await run(board(BOOTED, open(4301, 4302)), log);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "current", added: [], dropped: []});
		expect(fs.written.size).toBe(0);
	});

	it("refuses to drop a landed child, and leaves events.jsonl byte-identical", async () => {
		const log =
			line("issue_4302", "WIP", AT(1)) +
			line("issue_4302", "DONE", AT(2)) +
			line("issue_4302", "PASS", AT(3)) +
			line("issue_4302", "DONE", AT(4));
		const {out, fs} = await run(board(bodyOf("- phase 1: #4301"), open(4301, 4302)), log);

		expect(out.code).toBe(AMEND_DROPS_LANDED);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain('"issue_4302" (landed in "landed")');
	});

	it("refuses a task whose recorded history the re-derived machine cannot replay, log untouched", async () => {
		const log = line("issue_4302", "WIP", AT(1));
		// The second child reads closed-completed since emission, so its re-derived region BOOTS in
		// `landed` — a final holding no `WIP` cell, which the recorded log can no longer reach.
		const {out, fs} = await run(
			board(BOOTED, [
				{number: 4301, state: "open", stateReason: null},
				{number: 4302, state: "closed", stateReason: "completed"},
			]),
			log,
		);

		expect(out.code).toBe(AMEND_UNREPLAYABLE);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("issue_4302");
	});

	it("refuses an unparseable `## Dependencies` block on its own seat, log untouched", async () => {
		const log = line("issue_4301", "WIP", AT(1));
		const {out, fs} = await run(
			board(bodyOf("- phase 1: #4301, #4302", "and then we shipped it"), open(4301, 4302)),
			log,
		);

		expect(out.code).toBe(TOPOLOGY_MALFORMED);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		expect(out.stderr.join("\n")).toContain("does not parse");
	});
});

describe("lane amend --defer", () => {
	const REASON = "founder deferred it to a follow-up cycle";
	const DESCOPED = bodyOf("- phase 1: #4301");

	/** The Pi case: four other children land, the fifth carries one BLOCKED and is deferred. */
	const blocked = (task: string, when: string): string =>
		`${JSON.stringify({task, event: `${task.toUpperCase()}.BLOCKED`, at: when, cause: "spawn-dead"} satisfies LogEntry)}\n`;

	it("drops the named task, keeps every recorded byte, and bounds the deferral at its last line", async () => {
		const log = line("issue_4301", "WIP", AT(1)) + blocked("issue_4302", AT(2));
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), log, undefined, {
			defer: ["issue_4302"],
			deferReason: REASON,
		});

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "amended",
			dropped: ["issue_4302"],
			deferred: [{task: "issue_4302", through: AT(2), reason: REASON}],
		});
		const written = fs.written.get(LOG) ?? "";
		expect(written.startsWith(log)).toBe(true);
		expect(JSON.parse(written.slice(log.length))).toEqual({
			task: "epic_4300",
			event: "EPIC_4300.AMENDED",
			at: NOW,
			tasks: ["issue_4301", "epic_4300"],
			defers: [{task: "issue_4302", through: AT(2), reason: REASON}],
		});
	});

	it("refuses the same drop with no --defer, leaving the log byte for byte where it was", async () => {
		const log = line("issue_4301", "WIP", AT(1)) + blocked("issue_4302", AT(2));
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), log);

		expect(out.code).toBe(AMEND_UNREPLAYABLE);
		expect(fs.written.has(LOG)).toBe(false);
		expect(fs.written.has(WORKFLOW)).toBe(false);
	});

	it("refuses a --defer carrying no reason before any read", async () => {
		const log = blocked("issue_4302", AT(2));
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), log, undefined, {
			defer: ["issue_4302"],
		});

		expect(out.code).toBe(DEFERRAL_REFUSED);
		expect(out.stderr.join("\n")).toContain("no --defer-reason says why");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses a --defer-reason naming no task", async () => {
		const {out} = await run(board(BOOTED, open(4301, 4302)), "", undefined, {
			deferReason: REASON,
		});

		expect(out.code).toBe(DEFERRAL_REFUSED);
		expect(out.stderr.join("\n")).toContain("--defer names no task");
	});

	it("refuses a --defer naming a task the topology still places", async () => {
		const log = blocked("issue_4302", AT(2));
		const {out, fs} = await run(
			board(bodyOf("- phase 1: #4301", "- phase 2: #4302"), open(4301, 4302)),
			log,
			undefined,
			{defer: ["issue_4302"], deferReason: REASON},
		);

		expect(out.code).toBe(DEFERRAL_REFUSED);
		expect(out.stderr.join("\n")).toContain("still places it in a phase");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses while a builder still holds the child's claim — a deferral detaches nobody", async () => {
		const log = blocked("issue_4302", AT(2));
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), log, undefined, {
			defer: ["issue_4302"],
			deferReason: REASON,
			ownership: () => Effect.succeed({_tag: "Held" as const, token: "build:s-1:n-1"}),
		});

		expect(out.code).toBe(DEFERRAL_REFUSED);
		expect(out.stderr.join("\n")).toContain("#4302 is held by build:s-1:n-1");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("refuses an unreadable ownership as UNKNOWN rather than as an absence", async () => {
		const log = blocked("issue_4302", AT(2));
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), log, undefined, {
			defer: ["issue_4302"],
			deferReason: REASON,
			ownership: () => Effect.succeed({_tag: "Unknown" as const, reason: "the thread 502'd"}),
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
		expect(fs.written.has(LOG)).toBe(false);
	});

	it("leaves the deferred task's own lines in place, and the amended lane folds through them", async () => {
		const log = line("issue_4301", "WIP", AT(1)) + blocked("issue_4302", AT(2));
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), log, undefined, {
			defer: ["issue_4302"],
			deferReason: REASON,
		});

		expect(out.code).toBe(0);
		const written = fs.written.get(LOG) ?? "";
		const parsed = parseLog(written);
		expect(parsed._tag).toBe("Parsed");
		const machine = compileText(fs.written.get(WORKFLOW) ?? "");
		expect(machine._tag).toBe("Compiled");
		const folded =
			parsed._tag === "Parsed" && machine._tag === "Compiled"
				? foldLog(machine.lane, parsed.entries)
				: null;
		expect(folded).toMatchObject({_tag: "Folded"});
		expect(folded?._tag === "Folded" && Object.keys(folded.states)).toEqual([
			"issue_4301",
			"epic_4300",
		]);
	});
});

describe("the deferral's recovery halves", () => {
	const REASON = "founder deferred it to a follow-up cycle";
	const DESCOPED = bodyOf("- phase 1: #4301");
	const PENDING = line("issue_4301", "WIP", AT(1)) + line("issue_4302", "BLOCKED", AT(2));
	const DEFERRING = {defer: ["issue_4302"], deferReason: REASON};

	it("records nothing when the append does not land — the machine is NOT amended", async () => {
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), PENDING, undefined, DEFERRING, [
			LOG,
		]);

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("the machine is NOT amended");
		expect(fs.written.has(WORKFLOW)).toBe(false);
	});

	it("leaves a recorded deferral whose machine write failed completable by a re-run", async () => {
		const {out, fs} = await run(board(DESCOPED, open(4301, 4302)), PENDING, undefined, DEFERRING, [
			WORKFLOW,
		]);

		expect(out.code).toBe(APPEND_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("Re-run this verb to complete it");

		// The half-applied state is honest under the OLD machine: the deferred task is still in it, so
		// its recorded lines fold exactly where they stood rather than reading as unknown.
		const written = fs.written.get(LOG) ?? "";
		const parsed = parseLog(written);
		const machine = compileText(machineText(BOOTED, open(4301, 4302)));
		const folded =
			parsed._tag === "Parsed" && machine._tag === "Compiled"
				? foldLog(machine.lane, parsed.entries)
				: null;
		expect(folded).toMatchObject({_tag: "Folded"});
		expect(folded?._tag === "Folded" && folded.states.issue_4302?.type).toBe("blocked");
	});

	it("refuses when the board read fails, before anything is written", async () => {
		const {out, fs} = await run(
			[
				[ISSUE, served(issuePayload({number: EPIC, body: DESCOPED}))],
				[SUBS, {status: 502, body: ""}],
			],
			PENDING,
			undefined,
			DEFERRING,
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(fs.written.has(LOG)).toBe(false);
		expect(fs.written.has(WORKFLOW)).toBe(false);
	});
});

/**
 * The case that produced this verb: four reviewed children landed, a fifth carries one `BLOCKED`
 * and the founder deferred it. The epic has to be able to finish over what it built.
 */
describe("an epic with four landed children and a fifth deferred", () => {
	const REASON = "founder deferred it to a follow-up cycle";
	const FIVE = bodyOf("- phase 1: #4301, #4302, #4303, #4304, #4305");
	const FOUR = bodyOf("- phase 1: #4301, #4302, #4303, #4304");
	const LANDED = [4301, 4302, 4303, 4304];

	const landing = (child: number): string =>
		line(`issue_${child}`, "WIP", AT(1)) +
		line(`issue_${child}`, "DONE", AT(2)) +
		line(`issue_${child}`, "PASS", AT(3)) +
		line(`issue_${child}`, "DONE", AT(4));

	const JOURNAL =
		LANDED.map(landing).join("") +
		`${JSON.stringify({
			task: "issue_4305",
			event: "ISSUE_4305.BLOCKED",
			at: AT(5),
			cause: "spawn-dead",
		} satisfies LogEntry)}\n`;

	it("applies the revised plan, keeps every original byte, and reaches the tail", async () => {
		const {out, fs} = await run(
			board(FOUR, open(...LANDED, 4305)),
			JOURNAL,
			machineText(FIVE, open(...LANDED, 4305)),
			{defer: ["issue_4305"], deferReason: REASON},
		);

		expect(out.code).toBe(0);
		const written = fs.written.get(LOG) ?? "";
		expect(written.startsWith(JOURNAL)).toBe(true);

		const parsed = parseLog(written);
		const machine = compileText(fs.written.get(WORKFLOW) ?? "");
		expect(parsed._tag).toBe("Parsed");
		expect(machine._tag).toBe("Compiled");
		if (parsed._tag !== "Parsed" || machine._tag !== "Compiled") return;

		const folded = foldLog(machine.lane, parsed.entries);
		expect(folded._tag).toBe("Folded");
		if (folded._tag !== "Folded") return;

		for (const child of LANDED) expect(folded.states[`issue_${child}`]?.type).toBe("landed");
		expect(folded.states.issue_4305).toBeUndefined();

		const status = deriveStatus(machine.lane, folded.states);
		expect(status.stateValue).toMatchObject({epic: {epic_4300: "review"}});
	});

	it("records no DONE, PASS or landing for the deferred child anywhere in the log", async () => {
		const {out, fs} = await run(
			board(FOUR, open(...LANDED, 4305)),
			JOURNAL,
			machineText(FIVE, open(...LANDED, 4305)),
			{defer: ["issue_4305"], deferReason: REASON},
		);

		expect(out.code).toBe(0);
		const written = fs.written.get(LOG) ?? "";
		const parsed = parseLog(written);
		if (parsed._tag !== "Parsed") throw new Error("the amended log does not parse");
		const about4305 = parsed.entries.filter((held) => held.task === "issue_4305");
		expect(about4305.map((held) => held.event)).toEqual(["ISSUE_4305.BLOCKED"]);
	});
});
