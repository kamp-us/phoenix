import {dirname} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Result} from "effect";
import {ProjectId} from "../project-id.ts";
import {scratchHome} from "../scratch-home.ts";
import {
	OpenProjects,
	openProjectsFile,
	ProjectAlreadyOpen,
	ProjectNotOpen,
	projectLabels,
	readOpenProjects,
	saveOpenProjects,
} from "./open-projects.ts";

const opened = (projects: OpenProjects, folder: string): OpenProjects => {
	const result = projects.open(folder);
	if (Result.isFailure(result)) throw result.failure;
	return result.success.projects;
};

const folders = (projects: OpenProjects) => projects.projects.map((project) => project.folder);

const labelsOf = (...paths: ReadonlyArray<string>): ReadonlyArray<string> =>
	projectLabels(paths.reduce(opened, OpenProjects.none).projects).map(({label}) => label);

describe("projectLabels", () => {
	it("labels each project by its folder's name, keyed as its program ids are scoped", () => {
		const projects = opened(opened(OpenProjects.none, "/work/phoenix"), "/work/demlik").projects;
		assert.deepStrictEqual(projectLabels(projects), [
			{key: ProjectId.of("/work/phoenix").key, label: "phoenix"},
			{key: ProjectId.of("/work/demlik").key, label: "demlik"},
		]);
	});

	it("adds the parent folder when two open folders share a name", () => {
		assert.deepStrictEqual(labelsOf("/code/kamp-us/phoenix", "/code/usirin/phoenix", "/code/tea"), [
			"kamp-us/phoenix",
			"usirin/phoenix",
			"tea",
		]);
	});

	it("climbs past a shared parent to the first folder that differs", () => {
		assert.deepStrictEqual(labelsOf("/a/lanes/phoenix", "/b/lanes/phoenix"), [
			"a/lanes/phoenix",
			"b/lanes/phoenix",
		]);
	});

	it("shows the whole path of a folder that runs out of parents first", () => {
		assert.deepStrictEqual(labelsOf("/phoenix", "/work/phoenix"), ["/phoenix", "work/phoenix"]);
	});

	it("drops the parent again once the clashing project closes", () => {
		const both = opened(opened(OpenProjects.none, "/a/phoenix"), "/b/phoenix");
		const closed = both.close("/b/phoenix");
		if (Result.isFailure(closed)) throw closed.failure;
		assert.deepStrictEqual(
			projectLabels(closed.success.projects.projects).map(({label}) => label),
			["phoenix"],
		);
	});
});

describe("OpenProjects", () => {
	it("opens projects in order, each keyed as its state directory is", () => {
		const projects = opened(opened(OpenProjects.none, "/work/alpha"), "/work/beta");
		assert.deepStrictEqual(folders(projects), ["/work/alpha", "/work/beta"]);
		assert.strictEqual(projects.projects[1]?.id.key, ProjectId.of("/work/beta").key);
	});

	it("refuses a folder already open, under any spelling of it", () => {
		const projects = opened(OpenProjects.none, "/work/alpha");
		const again = projects.open("/work/alpha/");
		assert.isTrue(Result.isFailure(again));
		if (Result.isSuccess(again)) return;
		assert.instanceOf(again.failure, ProjectAlreadyOpen);
		assert.strictEqual(again.failure.message, "the project /work/alpha is already open");
		assert.deepStrictEqual(folders(projects), ["/work/alpha"]);
	});

	it("closes one project and keeps the others in the order they opened", () => {
		const projects = opened(opened(opened(OpenProjects.none, "/work/a"), "/work/b"), "/work/c");
		const closing = projects.close("/work/b");
		assert.isTrue(Result.isSuccess(closing));
		if (Result.isFailure(closing)) return;
		assert.strictEqual(closing.success.project.folder, "/work/b");
		assert.deepStrictEqual(folders(closing.success.projects), ["/work/a", "/work/c"]);
		assert.deepStrictEqual(folders(projects), ["/work/a", "/work/b", "/work/c"]);
	});

	it("refuses to close a folder that is not open", () => {
		const closing = opened(OpenProjects.none, "/work/a").close("/work/z");
		assert.isTrue(Result.isFailure(closing));
		if (Result.isSuccess(closing)) return;
		assert.instanceOf(closing.failure, ProjectNotOpen);
		assert.strictEqual(closing.failure.message, "the project /work/z is not open");
	});

	it("records one entry per open folder, and a closed one drops out", () => {
		const projects = opened(opened(OpenProjects.none, "/work/a"), "/work/b");
		assert.deepStrictEqual(projects.record, {
			version: 1,
			projects: [{folder: "/work/a"}, {folder: "/work/b"}],
			trusted: [],
		});
		const closing = projects.close("/work/a");
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(closing.success.projects.record, {
			version: 1,
			projects: [{folder: "/work/b"}],
			trusted: [],
		});
	});

	it("keeps a trusted folder trusted across a close and a reopen, and records it", () => {
		const trusted = opened(OpenProjects.none, "/work/a").trust("/work/a").trust("/work/b");
		const closing = trusted.close("/work/a");
		if (Result.isFailure(closing)) throw closing.failure;
		const reopened = opened(closing.success.projects, "/work/a");
		assert.isTrue(reopened.trusted.trusts("/work/a"));
		assert.isTrue(reopened.trusted.trusts("/work/b/"));
		assert.deepStrictEqual(reopened.record, {
			version: 1,
			projects: [{folder: "/work/a"}],
			trusted: ["/work/a", "/work/b"],
		});
	});

	it("restores only the trust of a saved list, never which folders were open", () => {
		const restored = OpenProjects.restoring({
			version: 1,
			projects: [{folder: "/work/a"}],
			trusted: ["/work/a"],
		});
		assert.deepStrictEqual(restored.projects, []);
		assert.isTrue(restored.trusted.trusts("/work/a"));
		assert.isFalse(OpenProjects.restoring(null).trusted.trusts("/work/a"));
	});
});

describe("the saved open-projects list", () => {
	it.effect("reads back what was saved, and reads none before anything was", () =>
		Effect.gen(function* () {
			const home = scratchHome("open-projects");
			assert.isNull(yield* readOpenProjects(home));
			yield* saveOpenProjects(home, opened(opened(OpenProjects.none, "/work/a"), "/work/b"));
			assert.deepStrictEqual(yield* readOpenProjects(home), {
				version: 1,
				projects: [{folder: "/work/a"}, {folder: "/work/b"}],
				trusted: [],
			});
			yield* saveOpenProjects(home, OpenProjects.none.trust("/work/c"));
			assert.deepStrictEqual(yield* readOpenProjects(home), {
				version: 1,
				projects: [],
				trusted: ["/work/c"],
			});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("reads a list written before trust was recorded as trusting nothing", () =>
		Effect.gen(function* () {
			const home = scratchHome("open-projects-untrusted");
			const fs = yield* FileSystem.FileSystem;
			yield* fs.makeDirectory(dirname(openProjectsFile(home)), {recursive: true});
			yield* fs.writeFileString(
				openProjectsFile(home),
				JSON.stringify({version: 1, projects: [{folder: "/work/a"}]}),
			);
			assert.deepStrictEqual(yield* readOpenProjects(home), {
				version: 1,
				projects: [{folder: "/work/a"}],
				trusted: [],
			});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
