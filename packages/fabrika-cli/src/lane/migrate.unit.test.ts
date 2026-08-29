/** The migration judgement and the sweep verb over it. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {MIGRATION_UNSAFE, SHAPE_MISMATCH} from "./codes.ts";
import type {ExpectationReader} from "./expectation.ts";
import {choreTemplateText, coderTemplateText} from "./fixtures.test-support.ts";
import type {LogEntry} from "./fold.ts";
import {type CompiledLane, compileText} from "./machine.ts";
import {graftContext, judgeMigration} from "./migrate.ts";
import {runMigrate} from "./migrate-verb.ts";

const ROOT = ".fabrika/lanes";
const TEMPLATE = "/repo/templates/coder.workflow.json";
const CHORE_TEMPLATE = "/repo/templates/chore.workflow.json";

const compiled = (text: string): CompiledLane => {
	const result = compileText(text);
	if (result._tag === "Malformed") throw new Error(result.defects.join("; "));
	return result.lane;
};

const log = (...events: ReadonlyArray<string>): ReadonlyArray<LogEntry> =>
	events.map((event) => ({task: "issue", event: `ISSUE.${event}`, at: "2026-08-20T00:00:00.000Z"}));

const logText = (...events: ReadonlyArray<string>): string =>
	`${log(...events)
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;

/** The machine every booted lane carries today: no `ship:queued`, no `WIP` cell on `ship`. */
const preWaitCellTemplate = (): string => {
	const document = JSON.parse(coderTemplateText());
	const states = document.machine.states.pipeline.states.issue.states;
	delete states["ship:queued"];
	delete states["human:queue-stall"];
	delete states.ship.on["ISSUE.WIP"];
	return JSON.stringify(document, null, "\t");
};

describe("graftContext", () => {
	it("keeps the lane's own context, so a per-lane budget survives the swap", () => {
		const lane = JSON.parse(preWaitCellTemplate());
		lane.machine.context.issue = {retries: 0, maxRetries: 5, code: true};

		const grafted = graftContext(coderTemplateText(), JSON.stringify(lane));

		expect(grafted._tag).toBe("Grafted");
		if (grafted._tag !== "Grafted") return;
		const written = JSON.parse(grafted.text);
		expect(written.machine.context.issue).toEqual({retries: 0, maxRetries: 5, code: true});
		expect(written.machine.states.pipeline.states.issue.states["ship:queued"]).toBeDefined();
	});

	it("leaves a generated machine alone rather than calling it stale", () => {
		const emitted = JSON.parse(coderTemplateText());
		emitted.id = "epic-5817";

		expect(graftContext(coderTemplateText(), JSON.stringify(emitted))).toEqual({
			_tag: "Foreign",
			id: "epic-5817",
		});
	});

	it("is idempotent — what it writes is what it next reads as current", () => {
		const first = graftContext(coderTemplateText(), preWaitCellTemplate());
		if (first._tag !== "Grafted") throw new Error(first._tag);

		expect(graftContext(coderTemplateText(), first.text)).toEqual(first);
	});
});

describe("judgeMigration", () => {
	it("preserves a swap that adds states the log never visits", () => {
		const verdict = judgeMigration(
			compiled(preWaitCellTemplate()),
			compiled(coderTemplateText()),
			log("WIP", "DONE", "PASS"),
		);

		expect(verdict._tag).toBe("Preserved");
	});

	it("refuses a candidate the existing log cannot replay through", () => {
		const verdict = judgeMigration(
			compiled(coderTemplateText()),
			compiled(preWaitCellTemplate()),
			log("WIP", "DONE", "PASS", "WIP"),
		);

		expect(verdict).toMatchObject({_tag: "Unreplayable", through: "candidate"});
	});

	it("refuses a candidate that folds the same log to a different leaf", () => {
		const document = JSON.parse(coderTemplateText());
		document.machine.states.pipeline.states.issue.states.ship.on["ISSUE.WIP"] = "blocked";

		const verdict = judgeMigration(
			compiled(coderTemplateText()),
			compiled(JSON.stringify(document)),
			log("WIP", "DONE", "PASS", "WIP"),
		);

		expect(verdict).toMatchObject({
			_tag: "Drifts",
			drifts: [{task: "issue", from: "ship:queued", to: "blocked"}],
		});
	});

	it("names the lane's own machine when the log never replayed through that either", () => {
		const verdict = judgeMigration(
			compiled(preWaitCellTemplate()),
			compiled(coderTemplateText()),
			log("WIP", "DONE", "PASS", "WIP"),
		);

		expect(verdict).toMatchObject({_tag: "Unreplayable", through: "current"});
	});
});

/** What the verb would write for a lane whose context is the template's — its `current` shape. */
const migratedText = (): string => {
	const grafted = graftContext(coderTemplateText(), coderTemplateText());
	if (grafted._tag !== "Grafted") throw new Error(grafted._tag);
	return grafted.text;
};

describe("lane migrate", () => {
	const sweep = (
		files: Record<string, string | null>,
		options: {
			check?: boolean;
			dirs?: Record<string, ReadonlyArray<string> | null>;
			templatePaths?: ReadonlyArray<string>;
			expectations?: ExpectationReader<never> | null;
		} = {},
	) => {
		const fs = fakeFs({
			files: {[TEMPLATE]: coderTemplateText(), [CHORE_TEMPLATE]: choreTemplateText(), ...files},
			dirs: options.dirs ?? {[ROOT]: ["42", "43"]},
			directories: [ROOT],
		});
		return Effect.runPromise(
			Effect.provide(
				runMigrate({
					roots: [{root: ROOT, templatePaths: options.templatePaths ?? [TEMPLATE]}],
					check: options.check ?? false,
					expectations: options.expectations ?? null,
				}),
				fs.layer,
			),
		).then((outcome) => ({outcome, written: fs.written}));
	};

	it("writes the template over a stale lane whose log replays unchanged", async () => {
		const {outcome, written} = await sweep({
			[`${ROOT}/42/workflow.json`]: preWaitCellTemplate(),
			[`${ROOT}/42/events.jsonl`]: logText("WIP", "DONE"),
			[`${ROOT}/43/workflow.json`]: migratedText(),
		});

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).summary).toMatchObject({migrated: 1, current: 1, unsafe: 0});
		expect(written.get(`${ROOT}/42/workflow.json`)).toBe(migratedText());
	});

	it("reads a booted lane as current past the formatting `lane open` copied in", async () => {
		// `lane open` places the template's biome-formatted bytes and a graft re-serializes with a tab
		// indent, so comparing text called every un-migrated lane stale whatever machine it carried.
		const {outcome, written} = await sweep({
			[`${ROOT}/42/workflow.json`]: coderTemplateText(),
			[`${ROOT}/43/workflow.json`]: migratedText(),
		});

		expect(coderTemplateText()).not.toBe(migratedText());
		expect(JSON.parse(outcome.stdout).summary).toMatchObject({current: 2, stale: 0, migrated: 0});
		expect(written.size).toBe(0);
	});

	it("picks a lane's template by its own machine id, not by the root it sits under", async () => {
		const {outcome} = await sweep(
			{[`${ROOT}/42/workflow.json`]: choreTemplateText()},
			{dirs: {[ROOT]: ["42"]}, templatePaths: [TEMPLATE, CHORE_TEMPLATE]},
		);

		expect(JSON.parse(outcome.stdout).summary).toMatchObject({generated: 0, current: 1});
	});

	it("withholds every write under --check and still names the stale lanes", async () => {
		const {outcome, written} = await sweep(
			{
				[`${ROOT}/42/workflow.json`]: preWaitCellTemplate(),
				[`${ROOT}/42/events.jsonl`]: logText("WIP", "DONE"),
				[`${ROOT}/43/workflow.json`]: migratedText(),
			},
			{check: true},
		);

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).summary).toMatchObject({stale: 1, migrated: 0});
		expect(written.size).toBe(0);
	});

	it("refuses on an unsafe lane, writes none of it, and migrates the rest", async () => {
		const drifting = JSON.parse(coderTemplateText());
		drifting.machine.states.pipeline.states.issue.states.ship.on["ISSUE.WIP"] = "blocked";

		const {outcome, written} = await sweep({
			[`${ROOT}/42/workflow.json`]: JSON.stringify(drifting, null, "\t"),
			[`${ROOT}/42/events.jsonl`]: logText("WIP", "DONE", "PASS", "WIP"),
			[`${ROOT}/43/workflow.json`]: preWaitCellTemplate(),
			[`${ROOT}/43/events.jsonl`]: logText("WIP", "DONE"),
		});

		expect(outcome.code).toBe(MIGRATION_UNSAFE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("different state");
		expect(written.has(`${ROOT}/42/workflow.json`)).toBe(false);
		expect(written.get(`${ROOT}/43/workflow.json`)).toBe(migratedText());
	});

	it("reports an unreadable lane as a row rather than ending the sweep", async () => {
		const {outcome} = await sweep({
			[`${ROOT}/42/workflow.json`]: "{",
			[`${ROOT}/43/workflow.json`]: migratedText(),
		});

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).summary).toMatchObject({unreadable: 1, current: 1});
	});

	it("reports a generated machine without touching it", async () => {
		const emitted = JSON.parse(preWaitCellTemplate());
		emitted.id = "epic-5817";

		const {outcome, written} = await sweep({
			[`${ROOT}/42/workflow.json`]: JSON.stringify(emitted, null, "\t"),
			[`${ROOT}/43/workflow.json`]: migratedText(),
		});

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).summary).toMatchObject({generated: 1, current: 1});
		expect(written.size).toBe(0);
	});

	it("skips an entry that holds no lane at all", async () => {
		const {outcome} = await sweep({[`${ROOT}/43/workflow.json`]: coderTemplateText()});

		expect(JSON.parse(outcome.stdout).scanned).toEqual([{root: ROOT, present: true, lanes: 1}]);
	});

	it("refuses the whole sweep when a root is there and cannot be listed", async () => {
		const {outcome} = await sweep(
			{[`${ROOT}/43/workflow.json`]: coderTemplateText()},
			{dirs: {[ROOT]: null}},
		);

		expect(outcome.code).not.toBe(0);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN, never empty");
	});

	it("flags a coder-template lane on an epic that would otherwise have read current", async () => {
		const epics: ExpectationReader<never> = (issue) =>
			Effect.succeed(
				issue === 42
					? {_tag: "Read", expectation: {_tag: "Epic", children: 4}}
					: {_tag: "Read", expectation: {_tag: "Single"}},
			);

		const {outcome, written} = await sweep(
			{
				[`${ROOT}/42/workflow.json`]: migratedText(),
				[`${ROOT}/43/workflow.json`]: migratedText(),
			},
			{check: true, expectations: epics},
		);

		expect(outcome.code).toBe(SHAPE_MISMATCH);
		expect(written.size).toBe(0);
		expect(outcome.stderr.join("\n")).toContain("4 sub-issue link(s)");
		expect(outcome.stderr.join("\n")).toContain("fabrika lane emit <n>");
	});

	it("carries an unknown shape onto the row it lands on rather than reading it as a match", async () => {
		const unknown: ExpectationReader<never> = () =>
			Effect.succeed({_tag: "Unknown", reason: "the API answered 502"});

		const {outcome} = await sweep(
			{
				[`${ROOT}/42/workflow.json`]: migratedText(),
				[`${ROOT}/43/workflow.json`]: migratedText(),
			},
			{check: true, expectations: unknown},
		);

		expect(outcome.code).toBe(0);
		const lanes = JSON.parse(outcome.stdout).lanes;
		expect(lanes[0]).toMatchObject({
			verdict: "current",
			shape: {state: "unknown", reason: "the API answered 502"},
		});
	});

	it("asks the board nothing about a lane whose key is not an issue number", async () => {
		const asked: number[] = [];
		const expectations: ExpectationReader<never> = (issue) => {
			asked.push(issue);
			return Effect.succeed({_tag: "Read", expectation: {_tag: "Single"}});
		};

		const {outcome} = await sweep(
			{[`${ROOT}/park-sweep/workflow.json`]: choreTemplateText()},
			{
				dirs: {[ROOT]: ["park-sweep"]},
				templatePaths: [CHORE_TEMPLATE],
				expectations,
			},
		);

		expect(outcome.code).toBe(0);
		expect(asked).toEqual([]);
	});
});
