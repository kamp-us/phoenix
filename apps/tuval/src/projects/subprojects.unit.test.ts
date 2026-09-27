/**
 * Subprojects as domain values (#9689): opening one under an open project, the close cascade, the
 * saved list leaving them out, their labels, and the boundary rule over who may reach across.
 */

import {assert, describe, it} from "@effect/vitest";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {Result} from "effect";
import {SubprojectBoundary} from "./boundary.ts";
import {type OpenProject, OpenProjects, ProjectNotOpen, projectLabels} from "./open-projects.ts";

const opener = ProcessId.make("phoenix-key/worktree");
const other = ProcessId.make("phoenix-key/bystander");

const opened = (projects: OpenProjects, folder: string): OpenProjects => {
	const result = projects.open(folder);
	if (Result.isFailure(result)) throw result.failure;
	return result.success.projects;
};

const nested = (
	projects: OpenProjects,
	folder: string,
	parent: string,
	by: ProcessId = opener,
): OpenProjects => {
	const result = projects.openUnder(folder, parent, by);
	if (Result.isFailure(result)) throw result.failure;
	return result.success.projects;
};

const folders = (projects: ReadonlyArray<OpenProject>) => projects.map((project) => project.folder);

/** phoenix with lane-1 under it, lane-1 with deep under it, and demlik beside them all. */
const desk = () =>
	nested(
		nested(
			opened(opened(OpenProjects.none, "/code/phoenix"), "/code/demlik"),
			"/lanes/lane-1",
			"/code/phoenix",
		),
		"/lanes/deep",
		"/lanes/lane-1",
		ProcessId.make("lane-key/inner"),
	);

const find = (projects: OpenProjects, folder: string): OpenProject => {
	const project = projects.find(folder);
	if (project === undefined) throw new Error(`${folder} is not open`);
	return project;
};

describe("OpenProjects with subprojects", () => {
	it("opens a subproject under an open project, recording its parent and its opener", () => {
		const projects = desk();
		const lane = find(projects, "/lanes/lane-1");
		assert.strictEqual(lane.under?.parent.key, find(projects, "/code/phoenix").id.key);
		assert.strictEqual(lane.under?.opener, opener);
		assert.isUndefined(find(projects, "/code/phoenix").under);
	});

	it("refuses a subproject under a project that is not open", () => {
		const result = OpenProjects.none.openUnder("/lanes/lane-1", "/code/phoenix", opener);
		assert.isTrue(Result.isFailure(result));
		if (Result.isSuccess(result)) return;
		assert.instanceOf(result.failure, ProjectNotOpen);
	});

	it("closes a project with every subproject under it, the deepest first", () => {
		const closing = desk().close("/code/phoenix");
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(folders(closing.success.closed), [
			"/lanes/deep",
			"/lanes/lane-1",
			"/code/phoenix",
		]);
		assert.deepStrictEqual(folders(closing.success.projects.projects), ["/code/demlik"]);
	});

	it("closes a subproject alone and leaves its parent open", () => {
		const closing = desk().close("/lanes/deep");
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(folders(closing.success.closed), ["/lanes/deep"]);
		assert.deepStrictEqual(folders(closing.success.projects.projects), [
			"/code/phoenix",
			"/code/demlik",
			"/lanes/lane-1",
		]);
	});

	it("leaves every subproject out of the saved list, so a restart reopens none", () => {
		assert.deepStrictEqual(desk().record.projects, [
			{folder: "/code/phoenix"},
			{folder: "/code/demlik"},
		]);
	});

	it("labels a subproject under its parent's label", () => {
		assert.deepStrictEqual(
			projectLabels(desk().projects).map(({label}) => label),
			["phoenix", "demlik", "phoenix › lane-1", "phoenix › lane-1 › deep"],
		);
	});

	it("tells two same-named subprojects apart among their siblings only", () => {
		const projects = nested(
			nested(opened(OpenProjects.none, "/code/phoenix"), "/a/lane", "/code/phoenix"),
			"/b/lane",
			"/code/phoenix",
		);
		assert.deepStrictEqual(
			projectLabels(projects.projects).map(({label}) => label),
			["phoenix", "phoenix › a/lane", "phoenix › b/lane"],
		);
	});
});

describe("SubprojectBoundary", () => {
	const projects = desk();
	const boundary = SubprojectBoundary.of(projects.projects);
	const phoenix = find(projects, "/code/phoenix");
	const demlik = find(projects, "/code/demlik");
	const lane = find(projects, "/lanes/lane-1");
	const deep = find(projects, "/lanes/deep");

	it("lets the opener reach into the subproject it opened", () => {
		assert.isUndefined(boundary.refusal({project: phoenix, process: opener}, {project: lane}));
	});

	it("refuses the parent's other programs reaching down", () => {
		assert.strictEqual(
			boundary.refusal({project: phoenix, process: other}, {project: lane}),
			"it runs in a subproject, and only the program that opened the subproject reaches into it",
		);
	});

	it("stops the opener at its own subproject, not one nested further down", () => {
		assert.strictEqual(
			boundary.refusal({project: phoenix, process: opener}, {project: deep}),
			"it runs in a subproject nested further down, which only that subproject's opener reaches into",
		);
	});

	it("refuses a subproject's programs reaching up, however far", () => {
		const up = "a subproject cannot reach up to the project it is nested under";
		assert.strictEqual(boundary.refusal({project: lane, process: other}, {project: phoenix}), up);
		assert.strictEqual(boundary.refusal({project: deep, process: other}, {project: phoenix}), up);
	});

	it("leaves a reach within one project, to or from a global process, or between unrelated projects alone", () => {
		assert.isUndefined(boundary.refusal({project: lane, process: other}, {project: lane}));
		assert.isUndefined(boundary.refusal({project: undefined, process: other}, {project: lane}));
		assert.isUndefined(boundary.refusal({project: lane, process: other}, {project: undefined}));
		assert.isUndefined(boundary.refusal({project: demlik, process: other}, {project: lane}));
	});
});
