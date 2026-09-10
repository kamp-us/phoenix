/**
 * `lane amend` — the accepted re-derivation, and the three refusals that leave `events.jsonl` byte
 * for byte where they found it.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {issuePayload, served} from "../build/fixtures.test-support.ts";
import {fakeFs, fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {runAmend} from "./amend-verb.ts";
import {AMEND_DROPS_LANDED, AMEND_UNREPLAYABLE, TOPOLOGY_MALFORMED} from "./codes.ts";
import {emitMachine} from "./emit.ts";
import type {LogEntry} from "./fold.ts";

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
) => {
	const fs = fakeFs({files: {[WORKFLOW]: workflow, [LOG]: log}, directories: [DIR]});
	return Effect.runPromise(
		Effect.provide(
			runAmend(OPTIONS),
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
