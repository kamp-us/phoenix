import {Effect, type FileSystem, Layer, type Path} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, unconfigured} from "../fakes.test-support.ts";
import {PROJECT_SCOPE_FIX} from "../io/projects.ts";
import {
	blankProject,
	type FakeProjectsOptions,
	fakeDatabaseId,
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

const configured = (table: unknown): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify({table})}}).layer;

const setupOn = (
	github: ReturnType<typeof fakeProjects>,
	fs: Layer.Layer<FileSystem.FileSystem | Path.Path> = unconfigured,
) =>
	Effect.runPromise(
		Effect.provide(
			runSetup({repo: REPO, cwd: "/repo", env: {}}),
			Layer.mergeAll(fs, fakeShell([]).layer, github.layer),
		),
	);

const run = async (options: FakeProjectsOptions = {}) => {
	const github = fakeProjects({repo: REPO, ...options});
	const outcome = await setupOn(github);
	return {outcome, github};
};

const mutations = (github: ReturnType<typeof fakeProjects>): ReadonlyArray<string> =>
	github.operations.filter((operation) =>
		/^(Table(Create|Update|Add|Set|Status|Link)|REST POST)/.test(operation),
	);

describe("table setup on a repo with no `table` block", () => {
	it("creates the project with its fields, the Table day date field, the five views and the README", async () => {
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
			["Outcome", "SINGLE_SELECT"],
			["Table day", "DATE"],
		]);
		expect(custom.some((field) => field.dataType === "ITERATION")).toBe(false);
		expect(
			custom.find((field) => field.name === "Outcome")?.options?.map((option) => option.name),
		).toEqual(["worked", "didn't", "can't tell"]);
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
			"Group members",
			"Inbox",
		]);
		expect(views.get("Inbox")?.filter).toBe("is:open no:label");
		expect(views.get("Lanes")?.layout).toBe("BOARD_LAYOUT");
		expect(views.get("Agenda")?.filter).toBe(
			'table-day:@today..@today+6d has:section -section:"Outside the bets" has:rec',
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
			"Outcome",
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
			"Outcome",
			"Table day",
		]) {
			expect(project?.readme).toContain(`## ${column}`);
		}
		expect(project?.readme).not.toContain("add the coming");
	});

	it("creates each missing view over REST, grouped, naming every field by its numeric id", async () => {
		const {github} = await run();
		const project = github.projects[0];
		const idOf = (name: string): number => {
			const field = project?.fields.find((one) => one.name === name);
			if (field === undefined) throw new Error(`no field ${name}`);
			return fakeDatabaseId(field);
		};
		const bodies = github.operations.flatMap((operation, index) =>
			operation === "REST POST views" ? [github.variables[index] ?? {}] : [],
		);
		const paths = github.requests.filter((request) => request.startsWith("POST /"));

		expect(paths).toHaveLength(5);
		for (const path of paths)
			expect(path).toBe(`POST /orgs/acme/projectsV2/${project?.number}/views`);
		expect(github.operations).not.toContain("TableCreateView");
		expect(bodies.find((body) => body.name === "Agenda")).toEqual({
			name: "Agenda",
			layout: "table",
			filter: 'table-day:@today..@today+6d has:section -section:"Outside the bets" has:rec',
			visible_fields: [
				"Title",
				"Stage",
				"Size",
				"Spent $",
				"Asks",
				"Rec",
				"In plain words",
				"Outcome",
			].map(idOf),
			group_by: [idOf("Section")],
		});
		expect(bodies.find((body) => body.name === "Lanes")).toMatchObject({
			layout: "board",
			vertical_group_by: [idOf("Stage")],
		});
		expect(bodies.find((body) => body.name === "Lanes")).not.toHaveProperty("group_by");
		expect(bodies.find((body) => body.name === "Inbox")).not.toHaveProperty("group_by");
		const views = new Map((project?.views ?? []).map((view) => [view.name, view]));
		expect(views.get("Agenda")?.groupBy).toEqual([
			project?.fields.find((one) => one.name === "Section")?.id,
		]);
	});

	it("leaves a view that already stands as it is grouped, creating only the missing ones", async () => {
		const started = blankProject({number: 20, title: "widgets table"});
		started.views.push({
			id: "own_agenda",
			number: 2,
			name: "Agenda",
			layout: "TABLE_LAYOUT",
			filter: null,
			fieldIds: [],
			groupBy: ["own_grouping"],
		});
		const {outcome, github} = await run({projects: [started]});

		expect(outcome.code, outcome.stderr.join("\n")).toBe(0);
		const created = github.operations.flatMap((operation, index) =>
			operation === "REST POST views" ? [String(github.variables[index]?.name)] : [],
		);
		expect(created).toEqual(["Outside the bets", "Lanes", "Group members", "Inbox"]);
		const agenda = github.projects[0]?.views.filter((view) => view.name === "Agenda");
		expect(agenda).toHaveLength(1);
		expect(agenda?.[0]?.groupBy).toEqual(["own_grouping"]);
	});

	it("prints the grouping and Inbox auto-add steps, and the README's by-hand section lists them", async () => {
		const {outcome, github} = await run();

		const {manualSteps} = JSON.parse(outcome.stdout) as {manualSteps: string[]};
		expect(manualSteps).toHaveLength(2);
		expect(manualSteps[0]).toContain("Group by: Section");
		expect(manualSteps[1]).toContain(`\`${INBOX_AUTO_ADD_FILTER}\``);
		expect(manualSteps.join(" ")).not.toContain("weeks");
		expect(INBOX_AUTO_ADD_FILTER).toBe("is:issue is:open no:label");
		expect(outcome.stderr.filter((line) => line.includes("manual step"))).toHaveLength(2);

		const readme = github.projects[0]?.readme ?? "";
		const byHand = readme.slice(
			readme.indexOf("## By hand"),
			readme.indexOf("# What the columns mean"),
		);
		for (const step of manualSteps) expect(byHand).toContain(step);
	});

	it("names no path, repository, issue number or login beyond the repository it set up", async () => {
		const {github} = await run();
		const readme = github.projects[0]?.readme ?? "";
		expect(readme).not.toMatch(/#\d|@(?!today\b)\w/);
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

	it("reuses an open project under the owner that carries the title but is not linked, and links it", async () => {
		const unlinked = {...blankProject({number: 9, title: "widgets table"}), linked: false};
		const {outcome, github} = await run({projects: [unlinked]});

		expect(outcome.code).toBe(0);
		const answered = JSON.parse(outcome.stdout);
		expect(answered.answer).toBe("reconciled");
		expect(answered.project.number).toBe(9);
		expect(answered.changes[0]).toContain("linked project #9");
		expect(github.projects).toHaveLength(1);
		expect(github.projects[0]?.linked).toBe(true);
		expect(mutations(github)).not.toContain("TableCreateProject");

		const again = await setupOn(github);
		expect(JSON.parse(again.stdout)).toMatchObject({answer: "unchanged", changes: []});
	});

	it("does not reuse a closed project carrying the title", async () => {
		const closed = {
			...blankProject({number: 9, title: "widgets table"}),
			linked: false,
			closed: true,
		};
		const {outcome, github} = await run({projects: [closed]});

		expect(JSON.parse(outcome.stdout).answer).toBe("created");
		expect(github.projects).toHaveLength(2);
		expect(github.projects[0]?.linked).toBe(false);
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

	it("refuses two unlinked projects under the owner carrying the table's title", async () => {
		const {outcome, github} = await run({
			projects: [
				{...blankProject({number: 3, title: "widgets table"}), linked: false},
				{...blankProject({number: 4, title: "widgets table"}), linked: false},
			],
		});

		expect(outcome.code).toBe(AMBIGUOUS_PROJECT);
		expect(outcome.stderr.join("\n")).toContain("under acme");
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

describe("table setup with a boards block", () => {
	const split = fakeFs({
		files: {"/repo/.fabrika.jsonc": JSON.stringify({boards: {onCall: {}}})},
	}).layer;

	it("creates the table and an on-call board whose Response target stands where Size would", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, split);

		expect(outcome.code).toBe(0);
		const answered = JSON.parse(outcome.stdout);
		expect(answered.answer).toBe("created");
		expect(answered.onCall).toMatchObject({answer: "created", project: {title: "widgets on-call"}});
		expect(github.projects.map((project) => [project.title, project.linked])).toEqual([
			["widgets table", true],
			["widgets on-call", true],
		]);

		const table = github.projects[0]?.fields.map((field) => field.name) ?? [];
		expect(table).toContain("Size");
		expect(table).not.toContain("Response target");
		const onCall = github.projects[1];
		const custom = (onCall?.fields ?? []).filter(
			(field) => !["Title", "Assignees", "Status", "Labels"].includes(field.name),
		);
		expect(custom.map((field) => [field.name, field.dataType])).toEqual([
			["Response target", "SINGLE_SELECT"],
			["In plain words", "TEXT"],
		]);
		expect(custom[0]?.options?.map((option) => option.name)).toEqual(["same day", "this week"]);
		expect(onCall?.views.map((view) => view.name).filter((name) => name !== "View 1")).toEqual([
			"Queue",
		]);
		expect(onCall?.readme).toContain("# How to use the on-call board");
	});

	it("writes nothing to either board on the second run", async () => {
		const github = fakeProjects({repo: REPO});
		await setupOn(github, split);
		const before = structuredClone(github.projects);

		const second = await setupOn(github, split);

		expect(JSON.parse(second.stdout)).toMatchObject({
			answer: "unchanged",
			onCall: {answer: "unchanged", changes: []},
		});
		expect(github.projects).toEqual(before);
	});

	it("answers exactly as before with no boards block: one board and no onCall key", async () => {
		const {outcome, github} = await run();

		expect(github.projects).toHaveLength(1);
		expect(Object.keys(JSON.parse(outcome.stdout))).toEqual([
			"answer",
			"repo",
			"project",
			"changes",
			"drift",
			"legacy",
			"manualSteps",
		]);
	});

	it("refuses a malformed boards block before reading GitHub", async () => {
		const github = fakeProjects({repo: REPO});
		const bad = fakeFs({
			files: {"/repo/.fabrika.jsonc": JSON.stringify({boards: {onCall: {spendShare: 0}}})},
		}).layer;

		expect((await setupOn(github, bad)).code).toBe(CONFIG_MALFORMED);
		expect(github.operations).toEqual([]);
	});
});

describe("table setup on a project set up with the Week iteration", () => {
	const legacy = () => {
		const project = blankProject({number: 20, title: "widgets table"});
		project.fields.push({
			id: "own_week",
			name: "Week",
			dataType: "ITERATION",
			iteration: {duration: 7, startDay: 6},
			iterations: [{id: "it_1", title: "Sep 26", startDate: "2026-09-26", duration: 7}],
		});
		return project;
	};

	it("adds Table day beside it, leaves Week exactly as it is and reports it as legacy", async () => {
		const {outcome, github} = await run({projects: [legacy()]});

		expect(outcome.code, outcome.stderr.join("\n")).toBe(0);
		const answered = JSON.parse(outcome.stdout);
		expect(answered.legacy).toHaveLength(1);
		expect(answered.legacy[0]).toContain("field Week (ITERATION) is legacy");
		expect(outcome.stderr.join("\n")).toContain("legacy: field Week (ITERATION) is legacy");
		const week = github.projects[0]?.fields.filter((field) => field.name === "Week");
		expect(week).toEqual([legacy().fields.at(-1)]);
		expect(github.projects[0]?.fields.some((field) => field.name === "Table day")).toBe(true);
		expect(github.operations.some((operation) => /Delete|Clear/.test(operation))).toBe(false);
		expect(github.requests.some((request) => /updateProjectV2Field\b/.test(request))).toBe(false);

		const again = await setupOn(github);
		expect(JSON.parse(again.stdout)).toMatchObject({answer: "unchanged", changes: []});
		expect(JSON.parse(again.stdout).legacy).toHaveLength(1);
	});
});

describe("table setup reads the size dollars from appetiteSizes", () => {
	const withConfig = (config: unknown): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
		fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify(config)}}).layer;

	const sizeDescriptions = (github: ReturnType<typeof fakeProjects>) =>
		github.projects[0]?.fields
			.find((field) => field.name === "Size")
			?.options?.map((option) => option.description);

	it("shows the shipped amounts when no key is set", async () => {
		const {outcome, github} = await run();

		expect(outcome.code).toBe(0);
		expect(sizeDescriptions(github)).toEqual([
			"About $15.",
			"About $35.",
			"About $40 per epic child.",
		]);
	});

	it("shows the amounts a repo configured for its pitches, in the Size options and the README", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, withConfig({appetiteSizes: {S: 20, M: 50, L: 90}}));

		expect(outcome.code).toBe(0);
		expect(sizeDescriptions(github)).toEqual([
			"About $20.",
			"About $50.",
			"About $90 per epic child.",
		]);
		const readme = github.projects[0]?.readme ?? "";
		expect(readme).toContain("- **S**: about $20.");
		expect(readme).toContain("- **M**: about $50.");
		expect(readme).toContain("- **L**: an epic, about $90 per child.");
	});

	it("reports each Size option whose description no longer shows a changed appetiteSizes, rewriting none", async () => {
		const github = fakeProjects({repo: REPO});
		expect((await setupOn(github)).code).toBe(0);

		const outcome = await setupOn(github, withConfig({appetiteSizes: {S: 20, M: 50, L: 90}}));

		expect(outcome.code).toBe(0);
		expect(sizeDescriptions(github)).toEqual([
			"About $15.",
			"About $35.",
			"About $40 per epic child.",
		]);
		expect(github.projects[0]?.readme ?? "").toContain("- **S**: about $20.");
		const answered = JSON.parse(outcome.stdout);
		expect(answered.answer).toBe("reconciled");
		expect(answered.drift).toHaveLength(1);
		const [drift] = answered.drift;
		expect(drift).toContain('option "S" as "About $15." where the table says "About $20."');
		expect(drift).toContain('option "M" as "About $35." where the table says "About $50."');
		expect(drift).toContain(
			'option "L" as "About $40 per epic child." where the table says "About $90 per epic child."',
		);
		expect(outcome.stderr.join("\n")).toContain(`drift: ${drift}`);
	});

	it("refuses a malformed appetiteSizes before reading GitHub", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, withConfig({appetiteSizes: {S: 50, M: 35, L: 40}}));

		expect(outcome.code).toBe(CONFIG_MALFORMED);
		expect(outcome.stderr.join("\n")).toContain("appetiteSizes");
		expect(github.operations).toEqual([]);
	});

	it("refuses a table block that names its own sizes, so no second key can disagree", async () => {
		const github = fakeProjects({repo: REPO});
		const outcome = await setupOn(github, configured({sizes: {S: 50}}));

		expect(outcome.code).toBe(CONFIG_MALFORMED);
		expect(outcome.stderr.join("\n")).toContain("`table.sizes`");
		expect(github.operations).toEqual([]);
	});
});
