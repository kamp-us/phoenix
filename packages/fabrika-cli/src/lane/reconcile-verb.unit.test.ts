/** `lane reconcile` — the sweep's two arms, what it appends, and what it refuses to leave silent. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import type {Closure} from "./prove.ts";
import type {ClosureRead} from "./reconcile.ts";
import {runReconcile} from "./reconcile-verb.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";

const NOW = "2026-09-01T12:00:00.000Z";
const at = (n: number): string => `2026-08-29T23:1${n}:00.000Z`;

const SHIPPED_PR = "https://github.com/kamp-us/phoenix/pull/7328";

const line = (event: string, when: string, pr?: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: when, ...(pr === undefined ? {} : {pr})})}\n`;

/**
 * The pre-0343 ledger #7433 reports: four events, the ship `DONE` naming the PR it shipped and
 * carrying no `partial`.
 */
const SHIPPED_LOG = `${line("WIP", at(0))}${line("DONE", at(1))}${line("PASS", at(2))}${line("DONE", at(3), SHIPPED_PR)}`;

interface LaneFixture {
	readonly lane: string;
	readonly log?: string;
	readonly workflow?: string | null;
}

const TEMPLATE = "templates/coder.workflow.json";

/** As much of the committed coder document as {@link preGuardWorkflow} reaches into. */
interface CoderDocument {
	id: string;
	machine: {
		states: {
			pipeline: {states: {issue: {states: Record<string, {on: Record<string, unknown>}>}}};
		};
	};
}

/**
 * The committed template with ADR 0343's guard removed — the machine every lane on disk booted from
 * before that ADR shipped, and the reason a stale lane cannot judge its own merge.
 */
const preGuardWorkflow = (): string => {
	const document: CoderDocument = JSON.parse(coderTemplateText());
	const states = document.machine.states.pipeline.states.issue.states;
	for (const name of ["ship", "ship:queued"]) {
		const node = states[name];
		if (node === undefined) throw new Error(`the committed template holds no "${name}" state`);
		node.on["ISSUE.DONE"] = "shipped";
	}
	return JSON.stringify(document, null, "\t");
};

const tree = (lanes: ReadonlyArray<LaneFixture>, extra: FakeFsOptions = {}) => {
	const files: Record<string, string | null> = {[TEMPLATE]: coderTemplateText()};
	const names: string[] = [];
	for (const {lane, log, workflow} of lanes) {
		names.push(lane);
		const value = workflow === undefined ? coderTemplateText() : workflow;
		if (value !== null) files[`${DEFAULT_LANES_ROOT}/${lane}/workflow.json`] = value;
		if (log !== undefined) files[`${DEFAULT_LANES_ROOT}/${lane}/events.jsonl`] = log;
	}
	return fakeFs({
		files,
		dirs: {[DEFAULT_LANES_ROOT]: names},
		directories: [DEFAULT_LANES_ROOT],
		...(extra.unreadable === undefined ? {} : {unreadable: extra.unreadable}),
		...(extra.unwritable === undefined ? {} : {unwritable: extra.unwritable}),
	});
};

const partial = (prs: ReadonlyArray<number>): Closure => ({_tag: "Partial", prs});
const closes = (why: string): Closure => ({_tag: "Closes", why});

/** The sweep with a scripted closure reader, and every `(issue, pr)` pair it asked the board about. */
const sweep = (
	fs: ReturnType<typeof fakeFs>,
	closure: (issue: number) => ClosureRead,
	check = false,
) => {
	const asked: Array<readonly [number, string | null]> = [];
	return Effect.runPromise(
		Effect.provide(
			runReconcile({
				roots: [{root: DEFAULT_LANES_ROOT, templatePaths: [TEMPLATE]}],
				check,
				now: NOW,
				closures: (issue, pr) =>
					Effect.sync(() => {
						asked.push([issue, pr]);
						return closure(issue);
					}),
			}),
			fs.layer,
		),
	).then((outcome) => ({outcome, asked, fs}));
};

const rows = (stdout: string): ReadonlyArray<Record<string, unknown>> =>
	(JSON.parse(stdout) as {lanes: ReadonlyArray<Record<string, unknown>>}).lanes;

describe("runReconcile", () => {
	it("corrects a lane whose merged PR did not close its issue, by appending", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "6980", log: SHIPPED_LOG}]), () => ({
			_tag: "Read",
			closure: partial([7328]),
		}));
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)).toEqual([
			{
				key: "6980",
				root: DEFAULT_LANES_ROOT,
				verdict: "corrected",
				corrects: {task: "issue", at: at(3), state: "ship", pr: SHIPPED_PR},
				prs: [7328],
				from: "complete",
				to: JSON.stringify({pipeline: {issue: "queued"}}),
			},
		]);
		const log = fs.written.get(`${DEFAULT_LANES_ROOT}/6980/events.jsonl`) ?? "";
		expect(log.startsWith(SHIPPED_LOG)).toBe(true);
		expect(JSON.parse(log.slice(SHIPPED_LOG.length))).toEqual({
			task: "issue",
			event: "ISSUE.CORRECTED",
			at: NOW,
			partial: true,
			corrects: at(3),
		});
	});

	/**
	 * Lane 7740's shape (#7457). Between ADR 0351 and the fix that read the closure off the named PR,
	 * the ship stage wrote `partial: false` out of a nominator blind to a merged `Part of #N` — so
	 * that `false` is the fallthrough, not an answer, and the sweep has to reach it. The correction
	 * settles the line whichever way the board answers, so it is re-read at most once.
	 */
	it("corrects a `partial: false` the ship stage wrote before it read the named PR", async () => {
		const shipLine = `${JSON.stringify({task: "issue", event: "ISSUE.DONE", at: at(3), partial: false, pr: SHIPPED_PR})}\n`;
		const log = `${line("WIP", at(0))}${line("DONE", at(1))}${line("PASS", at(2))}${shipLine}`;
		const read = (): ClosureRead => ({_tag: "Read", closure: partial([7806])});

		const first = await sweep(tree([{lane: "7740", log}]), read);
		expect(first.outcome.code).toBe(0);
		expect(first.asked).toEqual([[7740, SHIPPED_PR]]);
		expect(rows(first.outcome.stdout)).toMatchObject([
			{
				key: "7740",
				verdict: "corrected",
				corrects: {task: "issue", at: at(3), state: "ship", pr: SHIPPED_PR},
				prs: [7806],
				from: "complete",
				to: JSON.stringify({pipeline: {issue: "queued"}}),
			},
		]);

		const corrected = first.fs.written.get(`${DEFAULT_LANES_ROOT}/7740/events.jsonl`) ?? "";
		const second = await sweep(tree([{lane: "7740", log: corrected}]), read);
		expect(second.asked).toEqual([]);
		expect(rows(second.outcome.stdout)).toEqual([
			{key: "7740", root: DEFAULT_LANES_ROOT, verdict: "current"},
		]);
	});

	it("records a merged PR that closed its issue, and moves no task doing it", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "6981", log: SHIPPED_LOG}]), () => ({
			_tag: "Read",
			closure: closes("#7329 closes #6981 on merge"),
		}));
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)).toMatchObject([
			{key: "6981", verdict: "confirmed", from: "complete", to: "complete"},
		]);
		const log = fs.written.get(`${DEFAULT_LANES_ROOT}/6981/events.jsonl`) ?? "";
		expect(log.startsWith(SHIPPED_LOG)).toBe(true);
		expect(JSON.parse(log.slice(SHIPPED_LOG.length))).toEqual({
			task: "issue",
			event: "ISSUE.CORRECTED",
			at: NOW,
			partial: false,
			corrects: at(3),
		});
	});

	it("reads the board once across two sweeps of a lane whose merge closed its issue", async () => {
		const fs = tree([{lane: "6981", log: SHIPPED_LOG}]);
		const read = (): ClosureRead => ({
			_tag: "Read",
			closure: closes("#7329 closes #6981 on merge"),
		});
		const first = await sweep(fs, read);
		const second = await sweep(fs, read);
		expect(first.asked).toEqual([[6981, SHIPPED_PR]]);
		expect(second.asked).toEqual([]);
		expect(rows(second.outcome.stdout)).toEqual([
			{key: "6981", root: DEFAULT_LANES_ROOT, verdict: "current"},
		]);
	});

	it("withholds the confirming append under --check, so the read is bought again", async () => {
		const {outcome, fs} = await sweep(
			tree([{lane: "6981", log: SHIPPED_LOG}]),
			() => ({_tag: "Read", closure: closes("#7329 closes #6981 on merge")}),
			true,
		);
		expect(rows(outcome.stdout)).toMatchObject([{key: "6981", verdict: "closes"}]);
		expect(fs.written.size).toBe(0);
	});

	it("reports without appending under --check", async () => {
		const {outcome, fs} = await sweep(
			tree([{lane: "6980", log: SHIPPED_LOG}]),
			() => ({_tag: "Read", closure: partial([7328])}),
			true,
		);
		expect(rows(outcome.stdout)).toMatchObject([{key: "6980", verdict: "misrouted"}]);
		expect(fs.written.size).toBe(0);
	});

	it("names a lane whose own machine predates the guard rather than calling it current", async () => {
		const {outcome, asked, fs} = await sweep(
			tree([{lane: "6980", log: SHIPPED_LOG, workflow: preGuardWorkflow()}]),
			() => ({_tag: "Read", closure: partial([7328])}),
		);
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)).toMatchObject([{key: "6980", verdict: "unmigrated"}]);
		expect(String(rows(outcome.stdout)[0]?.reason)).toContain("fabrika lane migrate");
		expect(asked).toEqual([]);
		expect(fs.written.size).toBe(0);
	});

	it("calls a lane no committed template grafts onto current, not unmigrated", async () => {
		// An emitted epic machine has no template to be brought up to, and its tail declares no partial
		// arm by design (ADR 0343) — neither is stale for want of one.
		const emitted: CoderDocument = JSON.parse(preGuardWorkflow());
		emitted.id = "epic-7140";
		const {outcome} = await sweep(
			tree([{lane: "7140", log: SHIPPED_LOG, workflow: JSON.stringify(emitted, null, "\t")}]),
			() => ({_tag: "Read", closure: partial([7328])}),
		);
		expect(rows(outcome.stdout)).toEqual([
			{key: "7140", root: DEFAULT_LANES_ROOT, verdict: "current"},
		]);
	});

	it("asks only about a correctable lane, and hands the reader the PR its line names", async () => {
		const {asked} = await sweep(
			tree([
				{lane: "6980", log: SHIPPED_LOG},
				{lane: "6982", log: line("WIP", at(0))},
				{lane: "6983"},
			]),
			() => ({_tag: "Read", closure: partial([7328])}),
		);
		expect(asked).toEqual([[6980, SHIPPED_PR]]);
	});

	it("reads an unreadable board as unknown, never as a closing merge", async () => {
		const {outcome, fs} = await sweep(tree([{lane: "6980", log: SHIPPED_LOG}]), () => ({
			_tag: "Unknown",
			reason: "cannot read the pull requests closing #6980: gh exited 1",
		}));
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)).toMatchObject([{key: "6980", verdict: "unknown"}]);
		expect(fs.written.size).toBe(0);
	});

	it("refuses a write sweep whose append did not land, naming it and the ones corrected", async () => {
		const blocked = tree(
			[
				{lane: "6980", log: SHIPPED_LOG},
				{lane: "6984", log: SHIPPED_LOG},
			],
			{unwritable: [`${DEFAULT_LANES_ROOT}/6984/events.jsonl`], files: {}, dirs: {}},
		);
		const {outcome} = await sweep(blocked, () => ({_tag: "Read", closure: partial([7328])}));
		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join(" ")).toContain("6984");
		expect(outcome.stderr.join(" ")).toContain("6980");
	});

	it("reports an already-broken ledger as a row rather than refusing the whole sweep", async () => {
		// Nothing here caused it and nothing here can fix it, so it is a row a reader routes on — the
		// refusal is reserved for an append this run tried and could not land.
		const {outcome} = await sweep(
			tree([
				{lane: "6985", log: "{not json\n"},
				{lane: "6980", log: SHIPPED_LOG},
			]),
			() => ({_tag: "Read", closure: partial([7328])}),
		);
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)).toMatchObject([
			{key: "6980", verdict: "corrected"},
			{key: "6985", verdict: "unreadable"},
		]);
	});

	it("refuses when a root is there and cannot be listed — the lane set is UNKNOWN", async () => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText()},
			dirs: {},
			directories: [DEFAULT_LANES_ROOT],
			unreadable: [DEFAULT_LANES_ROOT],
		});
		const {outcome} = await sweep(fs, () => ({_tag: "Read", closure: partial([7328])}));
		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(outcome.stdout).toBe("");
	});

	it("refuses when the committed template cannot be read — nothing was reconciled", async () => {
		const fs = fakeFs({
			files: {},
			dirs: {[DEFAULT_LANES_ROOT]: []},
			directories: [DEFAULT_LANES_ROOT],
		});
		const {outcome} = await sweep(fs, () => ({_tag: "Read", closure: partial([7328])}));
		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(outcome.stdout).toBe("");
	});

	it("answers an absent root as no lanes rather than as a fault", async () => {
		const fs = fakeFs({files: {[TEMPLATE]: coderTemplateText()}, dirs: {}, directories: []});
		const {outcome} = await sweep(fs, () => ({_tag: "Read", closure: partial([7328])}));
		expect(outcome.code).toBe(0);
		expect(rows(outcome.stdout)).toEqual([]);
	});
});
