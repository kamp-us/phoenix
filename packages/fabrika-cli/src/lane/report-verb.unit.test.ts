import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_ABSENT, TASK_UNKNOWN, TOKEN_UNRECOGNISED} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runHistory} from "./history-verb.ts";
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

const run = (
	fs: ReturnType<typeof fakeFs>,
	token: string,
	extra: {task?: string | null; pr?: string | null; comment?: string | null} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runReport({
				root: ROOT,
				lane: "42",
				token,
				task: extra.task ?? null,
				pr: extra.pr ?? null,
				comment: extra.comment ?? null,
			}),
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
