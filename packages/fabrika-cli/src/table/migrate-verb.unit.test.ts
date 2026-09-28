/**
 * `table migrate-week` against the in-memory Projects endpoint: a table set up with the Week
 * iteration gets each row's iteration start copied into Table day, once, and no request it sends
 * touches an iteration field's configuration.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, unconfigured} from "../fakes.test-support.ts";
import {
	blankProject,
	type FakeProject,
	fakeProjects,
	isMutation,
} from "../io/projects-fake.test-support.ts";
import {NOT_SET_UP} from "./codes.ts";
import {migrateBoard, runMigrate} from "./migrate-verb.ts";

const REPO = "acme/widgets";

/** A table from before Table day: Week holds two iterations, and three rows sit in them. */
const legacyTable = (withTableDay = true): FakeProject => {
	const project = blankProject({number: 20, title: "widgets table"});
	project.fields.push({
		id: "F_week",
		name: "Week",
		dataType: "ITERATION",
		iteration: {duration: 7, startDay: 6},
		iterations: [
			{id: "it_19", title: "Sep 19", startDate: "2026-09-19", duration: 7},
			{id: "it_26", title: "Sep 26", startDate: "2026-09-26", duration: 7},
		],
	});
	if (withTableDay) project.fields.push({id: "F_day", name: "Table day", dataType: "DATE"});
	project.items.push(
		{id: "PVTI_1", contentId: "I_1", number: 1, values: {F_week: {iterationId: "it_19"}}},
		{id: "PVTI_2", contentId: "I_2", number: 2, values: {F_week: {iterationId: "it_26"}}},
		{
			id: "PVTI_3",
			contentId: "I_3",
			number: 3,
			values: {F_week: {iterationId: "it_19"}, F_day: {date: "2026-10-03"}},
		},
		{id: "PVTI_4", contentId: "I_4", number: 4, values: {}},
	);
	return project;
};

const migrate = (github: ReturnType<typeof fakeProjects>) =>
	Effect.runPromise(
		Effect.provide(
			runMigrate({repo: REPO, cwd: "/repo", env: {}, board: migrateBoard}),
			Layer.mergeAll(unconfigured, fakeShell([]).layer, github.layer),
		),
	);

const dayOf = (github: ReturnType<typeof fakeProjects>, item: string): unknown =>
	github.projects[0]?.items.find((one) => one.id === item)?.values.F_day;

describe("table migrate-week", () => {
	it("copies each undated row's Week start into Table day, leaving a dated row as it is", async () => {
		const github = fakeProjects({repo: REPO, projects: [legacyTable()]});
		const out = await migrate(github);

		expect(out.code, out.stderr.join("\n")).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			answer: "migrated",
			dated: [
				{issue: 1, tableDay: "2026-09-19"},
				{issue: 2, tableDay: "2026-09-26"},
			],
			unresolved: [],
		});
		expect(dayOf(github, "PVTI_1")).toEqual({date: "2026-09-19"});
		expect(dayOf(github, "PVTI_2")).toEqual({date: "2026-09-26"});
		expect(dayOf(github, "PVTI_3")).toEqual({date: "2026-10-03"});
		expect(dayOf(github, "PVTI_4")).toBeUndefined();
	});

	it("writes nothing on a second run", async () => {
		const github = fakeProjects({repo: REPO, projects: [legacyTable()]});
		await migrate(github);
		const writes = github.operations.filter((operation) => operation === "TableSetValue").length;
		const before = structuredClone(github.projects);

		const again = await migrate(github);

		expect(again.code).toBe(0);
		expect(JSON.parse(again.stdout)).toMatchObject({answer: "unchanged", dated: []});
		expect(github.operations.filter((operation) => operation === "TableSetValue")).toHaveLength(
			writes,
		);
		expect(github.projects).toEqual(before);
	});

	it("sends no updateProjectV2Field, and leaves the Week field and its values exactly as they were", async () => {
		const github = fakeProjects({repo: REPO, projects: [legacyTable()]});
		const week = structuredClone(legacyTable().fields.find((field) => field.name === "Week"));
		await migrate(github);
		await migrate(github);

		expect(github.requests.length).toBeGreaterThan(0);
		expect(github.requests.some((request) => /\bupdateProjectV2Field\b/.test(request))).toBe(false);
		const mutations = github.requests.filter(isMutation);
		expect(mutations).toHaveLength(2);
		for (const mutation of mutations) expect(mutation).toContain("updateProjectV2ItemFieldValue(");
		expect(github.projects[0]?.fields.find((field) => field.name === "Week")).toEqual(week);
		for (const item of github.projects[0]?.items ?? []) {
			const original = legacyTable().items.find((one) => one.id === item.id);
			expect(item.values.F_week).toEqual(original?.values.F_week);
		}
		const written = github.variables.filter(
			(_, index) => github.operations[index] === "TableSetValue",
		);
		for (const vars of written) {
			expect(vars).toMatchObject({input: {fieldId: "F_day", value: {date: expect.any(String)}}});
		}
	});

	it("refuses and writes nothing on a project with no Table day field, naming table setup", async () => {
		const github = fakeProjects({repo: REPO, projects: [legacyTable(false)]});
		const out = await migrate(github);

		expect(out.code).toBe(NOT_SET_UP);
		expect(out.stderr.join("\n")).toContain("fabrika table setup");
		expect(github.operations).not.toContain("TableSetValue");
	});

	it("answers unchanged on a table that never had a Week field", async () => {
		const project = blankProject({number: 20, title: "widgets table"});
		project.fields.push({id: "F_day", name: "Table day", dataType: "DATE"});
		const github = fakeProjects({repo: REPO, projects: [project]});
		const out = await migrate(github);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({answer: "unchanged", dated: []});
		expect(out.stderr.join("\n")).toContain("no Week iteration field");
	});
});
