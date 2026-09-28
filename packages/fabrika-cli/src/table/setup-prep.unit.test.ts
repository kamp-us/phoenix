/**
 * `table setup` chained into `table prep` on one in-memory project, with no `.fabrika.jsonc`: the
 * Table day field setup creates is the one prep dates its rows in, so a prep run right after setup
 * finds the next table on any weekday with no week set up ahead.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, unconfigured} from "../fakes.test-support.ts";
import {absent, type ListedIssue, present} from "../io/issues.ts";
import {addItem, withProjects} from "../io/projects.ts";
import {fakeIssueNodeId, fakeProjects} from "../io/projects-fake.test-support.ts";
import {prepBoard, runPrep} from "./prep-verb.ts";
import {runSetup} from "./setup-verb.ts";

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
		Effect.provide(runSetup({repo: REPO, cwd: "/repo", env: {}}), layer),
	);
	const prep = await Effect.runPromise(
		Effect.provide(
			runPrep({repo: REPO, cwd: "/repo", env: {}, now, board: boardOn, dryRun: false}),
			layer,
		),
	);
	return {setup, prep, github};
};

describe("table prep right after table setup, with no .fabrika.jsonc", () => {
	it.each([
		["a Wednesday, two days past the Monday table", "2026-09-30T12:00:00Z", "2026-10-05"],
		["a Sunday, the day before the table", "2026-09-27T12:00:00Z", "2026-09-28"],
		["the Monday table day itself", "2026-09-28T12:00:00Z", "2026-09-28"],
		["a year on, with nothing set up ahead", "2027-09-29T12:00:00Z", "2027-10-04"],
	])("on %s, proposes rows dated the next table", async (_day, at, tableDay) => {
		const {setup, prep, github} = await setupThenPrep(new Date(at));

		expect(setup.code, setup.stderr.join("\n")).toBe(0);
		expect(prep.code, prep.stderr.join("\n")).toBe(0);
		const answer = JSON.parse(prep.stdout);
		expect(answer.answer).toBe("prepped");
		expect(answer.tableDay).toBe(tableDay);
		expect(answer.agenda).toEqual([expect.objectContaining({issue: REPORT.number})]);
		const project = github.projects[0];
		const dayField = project?.fields.find((field) => field.name === "Table day");
		expect(dayField?.dataType).toBe("DATE");
		const row = project?.items.find((item) => item.number === REPORT.number);
		expect(row?.values[dayField?.id ?? ""]).toEqual({date: tableDay});
	});
});
