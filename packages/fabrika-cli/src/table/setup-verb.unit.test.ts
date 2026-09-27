import {Effect, type FileSystem, Layer, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, unconfigured} from "../fakes.test-support.ts";
import {PROJECT_SCOPE_FIX} from "../io/projects.ts";
import {
	blankProject,
	type FakeProjectsOptions,
	fakeProjects,
} from "../io/projects-fake.test-support.ts";
import {
	AMBIGUOUS_PROJECT,
	CONFIG_MALFORMED,
	NO_TARGET,
	SCOPE_MISSING,
	SHAPE_CONFLICT,
} from "./codes.ts";
import {runSetup} from "./setup-verb.ts";
import {INBOX_AUTO_ADD_FILTER} from "./shape.ts";

const REPO = "acme/widgets";
const NOW = new Date("2026-09-30T12:00:00Z");

const configured = (table: unknown): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify({table})}}).layer;

const setupOn = (
	github: ReturnType<typeof fakeProjects>,
	fs: Layer.Layer<FileSystem.FileSystem | Path.Path> = unconfigured,
) =>
	Effect.runPromise(
		Effect.provide(
			runSetup({repo: REPO, cwd: "/repo", env: {}, now: () => NOW}),
			Layer.mergeAll(fs, fakeShell([]).layer, github.layer),
		),
	);

const run = async (options: FakeProjectsOptions = {}) => {
	const github = fakeProjects({repo: REPO, ...options});
	const outcome = await setupOn(github);
	return {outcome, github};
};

const mutations = (github: ReturnType<typeof fakeProjects>): ReadonlyArray<string> =>
	github.operations.filter((operation) => /^Table(Create|Update|Add|Set|Status)/.test(operation));

describe("table setup on a repo with no `table` block", () => {
	it("creates the project with the eight fields, the weekly iteration, the five views and the README", async () => {
		const {outcome, github} = await run();

		expect(outcome.code).toBe(0);
		const answered = JSON.parse(outcome.stdout);
		expect(answered.answer).toBe("created");
		const [project] = github.projects;
		expect(project?.title).toBe("widgets table");
		expect(project?.linked).toBe(true);

		const custom = (project?.fields ?? []).filter(
			(field) => !["Title", "Assignees", "Status", "Labels"].includes(field.name),
		);
		expect(custom.map((field) => [field.name, field.dataType])).toEqual([
			["Stage", "SINGLE_SELECT"],
			["Section", "SINGLE_SELECT"],
			["Size", "SINGLE_SELECT"],
			["Spent $", "NUMBER"],
			["Asks", "NUMBER"],
			["Origin", "SINGLE_SELECT"],
			["Rec", "TEXT"],
			["In plain words", "TEXT"],
			["Week", "ITERATION"],
		]);
		const week = custom.find((field) => field.name === "Week");
		expect(week?.iteration).toEqual({duration: 7, startDay: 1});
		expect(
			custom.find((field) => field.name === "Stage")?.options?.map((option) => option.name),
		).toEqual(["proposed", "bet", "not now", "in lane", "shipped", "check"]);
		expect(
			custom.find((field) => field.name === "Section")?.options?.map((option) => option.name),
		).toEqual(["Tails", "Customers", "New bets", "Outside the bets"]);

		const views = new Map((project?.views ?? []).map((view) => [view.name, view]));
		expect([...views.keys()].filter((name) => name !== "View 1")).toEqual([
			"Agenda",
			"Outside the bets",
			"Lanes",
			"Epic children",
			"Inbox",
		]);
		expect(views.get("Inbox")?.filter).toBe("is:open no:label");
		expect(views.get("Lanes")?.layout).toBe("BOARD_LAYOUT");
		expect(views.get("Agenda")?.filter).toBe(
			'is:open week:@current has:section -section:"Outside the bets"',
		);
		const idOf = new Map((project?.fields ?? []).map((field) => [field.id, field.name]));
		expect(views.get("Agenda")?.fieldIds.map((id) => idOf.get(id))).toEqual([
			"Title",
			"Stage",
			"Size",
			"Spent $",
			"Asks",
			"Rec",
			"In plain words",
		]);

		expect(project?.readme).toContain("# What the columns mean");
		for (const column of [
			"Stage",
			"Section",
			"Size",
			"Spent $",
			"Asks",
			"Origin",
			"Rec",
			"In plain words",
			"Week",
		]) {
			expect(project?.readme).toContain(`## ${column}`);
		}
	});

	it("prints the grouping step and the Inbox auto-add step, and the README's one-time setup lists both", async () => {
		const {outcome, github} = await run();

		const {manualSteps} = JSON.parse(outcome.stdout) as {manualSteps: string[]};
		expect(manualSteps).toHaveLength(2);
		expect(manualSteps[0]).toContain("Group by: Section");
		expect(manualSteps[1]).toContain(`\`${INBOX_AUTO_ADD_FILTER}\``);
		expect(INBOX_AUTO_ADD_FILTER).toBe("is:issue is:open no:label");
		expect(outcome.stderr.filter((line) => line.includes("manual step"))).toHaveLength(2);

		const readme = github.projects[0]?.readme ?? "";
		const oneTime = readme.slice(
			readme.indexOf("## One-time setup"),
			readme.indexOf("# What the columns mean"),
		);
		for (const step of manualSteps) expect(oneTime).toContain(step);
	});

	it("names no path, repository, issue number or login beyond the repository it set up", async () => {
		const {github} = await run();
		const readme = github.projects[0]?.readme ?? "";
		expect(readme).not.toMatch(/#\d|@(?!current\b)\w/);
		expect(new Set(readme.match(/[\w.-]+\/[\w.-]+/g))).toEqual(new Set([REPO]));
	});
});

describe("table setup is idempotent", () => {
	it("writes nothing on the second run and answers unchanged", async () => {
		const github = fakeProjects({repo: REPO});
		const first = await setupOn(github);
		expect(first.code).toBe(0);
		const before = structuredClone(github.projects);
		const writesBefore = mutations(github).length;

		const second = await setupOn(github);

		expect(second.code).toBe(0);
		expect(JSON.parse(second.stdout)).toMatchObject({answer: "unchanged", changes: []});
		expect(mutations(github).length).toBe(writesBefore);
		expect(github.projects).toEqual(before);
		expect(github.projects).toHaveLength(1);
	});

	it("finishes a project a person started, keeping what they added", async () => {
		const started = blankProject({number: 20, title: "widgets table"});
		started.fields.push({
			id: "own_stage",
			name: "Stage",
			dataType: "SINGLE_SELECT",
			options: [
				{id: "o1", name: "proposed", color: "GRAY", description: ""},
				{id: "o2", name: "notes", color: "GRAY", description: ""},
			],
		});
		const {outcome, github} = await run({projects: [started]});

		expect(outcome.code).toBe(0);
		const answered = JSON.parse(outcome.stdout);
		expect(answered.answer).toBe("reconciled");
		expect(answered.project.number).toBe(20);
		expect(github.projects).toHaveLength(1);
		const stage = github.projects[0]?.fields.filter((field) => field.name === "Stage");
		expect(stage).toHaveLength(1);
		expect(stage?.[0]?.options?.map((option) => option.name)).toEqual(["proposed", "notes"]);
		expect(answered.drift[0]).toContain('"bet"');
	});
});

describe("table setup's refusals", () => {
	it("refuses a token without the project scope with the exact fix, before any write", async () => {
		const {outcome, github} = await run({scopes: "repo, read:org"});

		expect(outcome.code).toBe(SCOPE_MISSING);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(PROJECT_SCOPE_FIX);
		expect(PROJECT_SCOPE_FIX).toBe("gh auth refresh -h github.com -s project");
		expect(mutations(github)).toEqual([]);
	});

	it("reads GitHub's INSUFFICIENT_SCOPES error as the same refusal when the token lists no scopes", async () => {
		const {outcome} = await run({insufficientScopes: true});

		expect(outcome.code).toBe(SCOPE_MISSING);
		expect(outcome.stderr.join("\n")).toContain(PROJECT_SCOPE_FIX);
	});

	it("does not create a project when the configured number names none", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, configured({project: {number: 99}}));

		expect(outcome.code).toBe(NO_TARGET);
		expect(mutations(github)).toEqual([]);
	});

	it("uses the configured project when it exists", async () => {
		const github = fakeProjects({
			repo: REPO,
			projects: [{...blankProject({number: 7, title: "Our table"}), linked: false}],
		});
		const outcome = await setupOn(github, configured({project: {number: 7}}));

		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).project).toMatchObject({number: 7, title: "Our table"});
		expect(github.projects).toHaveLength(1);
	});

	it("refuses two linked projects carrying the table's title", async () => {
		const {outcome, github} = await run({
			projects: [
				blankProject({number: 3, title: "widgets table"}),
				blankProject({number: 4, title: "widgets table"}),
			],
		});

		expect(outcome.code).toBe(AMBIGUOUS_PROJECT);
		expect(mutations(github)).toEqual([]);
	});

	it("refuses a field the table needs that holds another type, changing nothing", async () => {
		const clash = blankProject({number: 5, title: "widgets table"});
		clash.fields.push({id: "own_asks", name: "Asks", dataType: "TEXT"});
		const {outcome, github} = await run({projects: [clash]});

		expect(outcome.code).toBe(SHAPE_CONFLICT);
		expect(outcome.stderr.join("\n")).toContain("Asks is TEXT");
		expect(mutations(github)).toEqual([]);
	});

	it("refuses a malformed table block before reading GitHub", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, configured({agendaCap: 0}));

		expect(outcome.code).toBe(CONFIG_MALFORMED);
		expect(github.operations).toEqual([]);
	});
});

describe("table setup honours the table block", () => {
	it("starts the iteration on the configured day and runs it for the cadence", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, configured({cadence: "biweekly", day: "saturday"}));

		expect(outcome.code).toBe(0);
		const week = github.projects[0]?.fields.find((field) => field.name === "Week");
		expect(week?.iteration).toEqual({duration: 14, startDay: 6});
	});
});
