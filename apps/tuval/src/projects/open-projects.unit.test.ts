import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Result} from "effect";
import {ProjectId} from "../project-id.ts";
import {scratchHome} from "../scratch-home.ts";
import {
	OpenProjects,
	ProjectAlreadyOpen,
	ProjectNotOpen,
	readOpenProjects,
	saveOpenProjects,
} from "./open-projects.ts";

const opened = (projects: OpenProjects, folder: string): OpenProjects => {
	const result = projects.open(folder);
	if (Result.isFailure(result)) throw result.failure;
	return result.success.projects;
};

const folders = (projects: OpenProjects) => projects.projects.map((project) => project.folder);

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
		});
		const closing = projects.close("/work/a");
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(closing.success.projects.record, {
			version: 1,
			projects: [{folder: "/work/b"}],
		});
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
			});
			yield* saveOpenProjects(home, OpenProjects.none);
			assert.deepStrictEqual(yield* readOpenProjects(home), {version: 1, projects: []});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
