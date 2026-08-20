import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	CAUSE_UNRECOGNISED,
	LANE_ABSENT,
	PROOF_ABSENT,
	TASK_UNKNOWN,
	TOKEN_UNRECOGNISED,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runHistory} from "./history-verb.ts";
import type {ProveOptions} from "./prove-verb.ts";
import {SHELL_VOCABULARIES} from "./report.ts";
import {runReport} from "./report-verb.ts";

const ROOT = ".fabrika/lanes";
const WORKFLOW = `${ROOT}/42/workflow.json`;
const LOG = `${ROOT}/42/events.jsonl`;

const logLine = (event: string): string =>
	`${JSON.stringify({task: "issue", event: `ISSUE.${event}`, at: "2026-08-16T00:00:00.000Z"})}\n`;

/** The log prefix that folds the coder lane's task into the state each shell reports out of. */
const LOG_AT: Readonly<Record<"build" | "review" | "ship", string>> = {
	build: logLine("WIP"),
	review: logLine("WIP") + logLine("DONE"),
	ship: logLine("WIP") + logLine("DONE") + logLine("PASS"),
};

/**
 * A prover the test drives, standing in for `runProve` — it records what the verb asked it and
 * answers what the test wants read. `proof: "not-required"` is the shape `lane prove` answers with
 * at exit 0 for an event that claims no artifact.
 */
const fakeProver = (outcome: VerbOutcome = answer(JSON.stringify({proof: "not-required"}))) => {
	const asked: ProveOptions[] = [];
	return {
		asked,
		prove: (options: ProveOptions) =>
			Effect.sync(() => {
				asked.push(options);
				return outcome;
			}),
	};
};

const run = (
	fs: ReturnType<typeof fakeFs>,
	token: string,
	extra: {
		task?: string | null;
		pr?: string | null;
		comment?: string | null;
		cause?: string | null;
		prover?: ReturnType<typeof fakeProver>;
	} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runReport(
				{
					root: ROOT,
					lane: "42",
					token,
					task: extra.task ?? null,
					pr: extra.pr ?? null,
					comment: extra.comment ?? null,
					cause: extra.cause ?? null,
					repo: "kamp-us/phoenix",
					cwd: "/repo",
					env: {},
				},
				(extra.prover ?? fakeProver()).prove,
			),
			fs.layer,
		),
	);

const laneAt = (log: string) => fakeFs({files: {[WORKFLOW]: coderTemplateText(), [LOG]: log}});

/** The one line the run appended — `written` carries the whole file, prior log included. */
const appendedLine = (fs: ReturnType<typeof fakeFs>): string =>
	fs.written.get(LOG)?.trim().split("\n").at(-1) ?? "";

describe("lane report — every shell terminal token maps to one operator event", () => {
	const stateFor: Readonly<Record<keyof typeof SHELL_VOCABULARIES, "build" | "review" | "ship">> = {
		builder: "build",
		reviewer: "review",
		shipper: "ship",
	};

	for (const [shell, vocabulary] of Object.entries(SHELL_VOCABULARIES)) {
		for (const [token, event] of Object.entries(vocabulary)) {
			it(`${shell} ${token} records ${event}`, async () => {
				const fs = laneAt(LOG_AT[stateFor[shell as keyof typeof SHELL_VOCABULARIES]]);

				const out = await run(fs, token);
				expect(out.code).toBe(0);
				expect(JSON.parse(out.stdout)).toMatchObject({
					token,
					event: `ISSUE.${event}`,
					taskAffected: "issue",
				});
				expect(JSON.parse(appendedLine(fs))).toMatchObject({
					task: "issue",
					event: `ISSUE.${event}`,
				});
			});
		}
	}

	it("folds a lower-case token to its canonical spelling", async () => {
		const fs = laneAt(LOG_AT.ship);

		const out = await run(fs, "already-merged");
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({token: "ALREADY-MERGED", event: "ISSUE.DONE"});
	});
});

describe("lane report — refs on the event line", () => {
	it("records --pr and --comment on the appended line, and the line survives a history read", async () => {
		const fs = laneAt(LOG_AT.build);
		const pr = "https://github.com/kamp-us/phoenix/pull/9001";
		const comment = "https://github.com/kamp-us/phoenix/issues/42#issuecomment-1";

		const out = await run(fs, "SHIPPED-PR", {pr, comment});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({pr, comment});
		const appended = appendedLine(fs);
		expect(JSON.parse(appended)).toMatchObject({event: "ISSUE.DONE", pr, comment});

		const replayed = fakeFs({
			files: {[WORKFLOW]: coderTemplateText(), [LOG]: `${LOG_AT.build}${appended}\n`},
		});
		const history = await Effect.runPromise(
			Effect.provide(runHistory({root: ROOT, lane: "42"}), replayed.layer),
		);
		expect(history.code).toBe(0);
		expect(JSON.parse(history.stdout).at(-1)).toMatchObject({event: "ISSUE.DONE", pr, comment});
	});

	it("appends an event without refs exactly as transition does — no ref keys on the line", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "SHIPPED-PR");
		expect(out.code).toBe(0);
		const appended = JSON.parse(appendedLine(fs));
		expect(Object.keys(appended).sort()).toEqual(["at", "event", "task"]);
	});
});

describe("lane report — task addressing, both directions", () => {
	it("accepts an explicit --task naming the machine's task", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "SHIPPED-PR", {task: "issue"});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({taskAffected: "issue"});
	});

	it("refuses a task the machine does not have, nothing written", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "SHIPPED-PR", {task: "nope"});
		expect(out.code).toBe(TASK_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('"nope"');
		expect(fs.written.size).toBe(0);
	});
});

describe("lane report — refuse without append", () => {
	it("refuses an unrecognised token on its own code, log byte-identical", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "MOSTLY-DONE");
		expect(out.code).toBe(TOKEN_UNRECOGNISED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("MOSTLY-DONE");
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses a lane that is provably not there", async () => {
		const fs = fakeFs({files: {}});

		const out = await run(fs, "SHIPPED-PR");
		expect(out.code).toBe(LANE_ABSENT);
		expect(fs.written.size).toBe(0);
	});
});

describe("lane report — the append is proof-gated", () => {
	it("asks the prover for the mapped event on the resolved task, before appending", async () => {
		const fs = laneAt(LOG_AT.build);
		const prover = fakeProver();

		const out = await run(fs, "SHIPPED-PR", {prover});
		expect(out.code).toBe(0);
		expect(prover.asked).toEqual([
			{
				root: ROOT,
				lane: "42",
				event: "DONE",
				task: "issue",
				repo: "kamp-us/phoenix",
				cwd: "/repo",
				env: {},
			},
		]);
	});

	it("refuses on the prover's own code with the log byte-identical", async () => {
		const fs = laneAt(LOG_AT.build);
		const prover = fakeProver(
			refuse(PROOF_ABSENT, "fabrika lane prove: unproven — no open PR links #42"),
		);

		const out = await run(fs, "SHIPPED-PR", {prover});
		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr).toContain("fabrika lane prove: unproven — no open PR links #42");
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("never reaches the prover for a token no shell owns", async () => {
		const fs = laneAt(LOG_AT.build);
		const prover = fakeProver();

		const out = await run(fs, "MOSTLY-DONE", {prover});
		expect(out.code).toBe(TOKEN_UNRECOGNISED);
		expect(prover.asked).toEqual([]);
	});

	it("carries the proof's own diagnostics onto a recorded event", async () => {
		const fs = laneAt(LOG_AT.build);
		const prover = fakeProver(
			answer(JSON.stringify({proof: "proven"}), ["fabrika lane prove: read 3 candidate(s)."]),
		);

		const out = await run(fs, "SHIPPED-PR", {prover});
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("fabrika lane prove: read 3 candidate(s).");
	});
});

describe("lane report — the park cause a BLOCKED carries (#6480)", () => {
	it("records a known cause on the event line, where the fold reads it back", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "STOPPED", {cause: "worktree-holds-branch"});

		expect(out.code).toBe(0);
		expect(JSON.parse(appendedLine(fs))).toMatchObject({
			event: "ISSUE.BLOCKED",
			cause: "worktree-holds-branch",
		});
		expect(JSON.parse(out.stdout).cause).toBe("worktree-holds-branch");
	});

	it("case-folds the cause, so a shell's casing is not a second vocabulary", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "STOPPED", {cause: "Worktree-Holds-Branch"});

		expect(out.code).toBe(0);
		expect(JSON.parse(appendedLine(fs)).cause).toBe("worktree-holds-branch");
	});

	it("leaves a BLOCKED with no cause exactly the bare park it always was", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "STOPPED");

		expect(out.code).toBe(0);
		expect(Object.hasOwn(JSON.parse(appendedLine(fs)), "cause")).toBe(false);
	});

	it("refuses a cause outside the closed set, log unappended — never records an unkeyable one", async () => {
		const fs = laneAt(LOG_AT.build);

		const out = await run(fs, "STOPPED", {cause: "the-tree-was-busy"});

		expect(out.code).toBe(CAUSE_UNRECOGNISED);
		expect(out.stderr.at(-1)).toContain("log unappended");
		expect(fs.written.size).toBe(0);
	});

	it("refuses a cause on a token that is not a park, and never reaches the prover", async () => {
		const fs = laneAt(LOG_AT.build);
		const prover = fakeProver();

		const out = await run(fs, "SHIPPED-PR", {cause: "worktree-holds-branch", prover});

		expect(out.code).toBe(CAUSE_UNRECOGNISED);
		expect(prover.asked).toEqual([]);
		expect(fs.written.size).toBe(0);
	});
});
