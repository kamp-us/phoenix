/**
 * `table setup` chained into `table prep` on one in-memory project, with no `.fabrika.jsonc`: the
 * Week iterations setup creates are the ones prep reads, so a prep run right after setup finds the
 * week of the next table day on any weekday instead of refusing with no iteration.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type Cadence, SHIPPED_TABLE, WEEKDAYS} from "../config/keys/table.ts";
import {fakeShell, unconfigured} from "../fakes.test-support.ts";
import {absent, type ListedIssue, present} from "../io/issues.ts";
import {addItem, withProjects} from "../io/projects.ts";
import {fakeIssueNodeId, fakeProjects} from "../io/projects-fake.test-support.ts";
import {nextTableDay, targetIteration} from "./health.ts";
import {prepBoard, runPrep} from "./prep-verb.ts";
import {runSetup} from "./setup-verb.ts";
import {plannedIterations} from "./shape.ts";

const REPO = "acme/widgets";

/** A triaged report from someone who only uses the product: prep proposes it under Customers. */
const REPORT: ListedIssue = {
	number: 7,
	title: "Login fails on Safari",
	body: "",
	labels: ["status:triaged", "ready-for:agent"],
	author: "a-user",
	association: "NONE",
};

const unexpected = (what: string) => () => Effect.die(`prep reached ${what}, which no check needs`);

/** The shipped board with its project acts kept, and the repository's issue reads held in memory. */
const boardOn: typeof prepBoard = {
	...prepBoard,
	node: (_repo, number) =>
		Effect.succeed(
			number === REPORT.number
				? present({number, open: true, parent: null, subIssues: [], blockedBy: [], blocking: []})
				: absent(),
		),
	comments: () => Effect.succeed({_tag: "Ok", value: []}),
	deciders: () => Effect.succeed({_tag: "Roster", logins: new Set(["acme"])}),
	openIssues: () => Effect.succeed({_tag: "Ok", value: [REPORT]}),
	followUps: () => Effect.succeed({_tag: "Ok", value: []}),
	add: (projectId, _repo, issue) =>
		withProjects((token) => addItem(token, projectId, fakeIssueNodeId(issue))),
	issue: unexpected("an issue read"),
	timeline: unexpected("a timeline read"),
	source: unexpected("an evidence source"),
	comment: unexpected("a check comment"),
};

const setupThenPrep = async (now: Date) => {
	const github = fakeProjects({repo: REPO});
	const layer = Layer.mergeAll(unconfigured, fakeShell([]).layer, github.layer);
	const setup = await Effect.runPromise(
		Effect.provide(runSetup({repo: REPO, cwd: "/repo", env: {}, now: () => now}), layer),
	);
	const prep = await Effect.runPromise(
		Effect.provide(runPrep({repo: REPO, cwd: "/repo", env: {}, now, board: boardOn}), layer),
	);
	return {setup, prep};
};

describe("table prep right after table setup, with no .fabrika.jsonc", () => {
	it.each([
		["a Wednesday, two days past the Monday table", "2026-09-30T12:00:00Z", "Oct 5", "2026-10-05"],
		["a Sunday, the day before the table", "2026-09-27T12:00:00Z", "Sep 28", "2026-09-28"],
		["the Monday table day itself", "2026-09-28T12:00:00Z", "Sep 28", "2026-09-28"],
	])("on %s, proposes rows for the next table's week", async (_day, at, title, startDate) => {
		const {setup, prep} = await setupThenPrep(new Date(at));

		expect(setup.code, setup.stderr.join("\n")).toBe(0);
		expect(prep.code, prep.stderr.join("\n")).toBe(0);
		const answer = JSON.parse(prep.stdout);
		expect(answer.answer).toBe("prepped");
		expect(answer.iteration).toMatchObject({title, startDate});
		expect(answer.agenda).toEqual([expect.objectContaining({issue: REPORT.number})]);
	});
});

describe("the Week iterations setup plans", () => {
	const days = Array.from({length: 7}, (_, offset) => new Date(Date.UTC(2026, 8, 27 + offset, 9)));
	const cadences: ReadonlyArray<Cadence> = ["weekly", "biweekly", "on-demand"];

	it.each(
		cadences.flatMap((cadence) => WEEKDAYS.map((day) => [cadence, day] as const)),
	)("cover the next table day from every weekday, for a %s table on %s", (cadence, day) => {
		const settings = {...SHIPPED_TABLE, cadence, day};
		for (const today of days) {
			const planned = plannedIterations(settings, today).map((one, index) => ({
				id: `it_${index}`,
				title: one.title,
				startDate: one.startDate,
				duration: cadence === "biweekly" ? 14 : 7,
			}));
			const target = targetIteration(planned, settings, today);
			expect(
				target,
				`${today.toISOString()} → ${nextTableDay(settings, today).toISOString()}`,
			).not.toBeNull();
		}
	});
});
