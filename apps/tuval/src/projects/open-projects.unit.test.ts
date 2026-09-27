import {dirname} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {Effect, FileSystem, Result} from "effect";
import {ProjectId} from "../project-id.ts";
import {scratchHome} from "../scratch-home.ts";
import {
	OpenProjects,
	openProjectsFile,
	ProjectAlreadyOpen,
	ProjectNotOpen,
	projectLabels,
	RECENT_LIMIT,
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
		const closed = both.close("/b/phoenix", undefined);
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
		const closing = projects.close("/work/b", undefined);
		assert.isTrue(Result.isSuccess(closing));
		if (Result.isFailure(closing)) return;
		assert.strictEqual(closing.success.project.folder, "/work/b");
		assert.deepStrictEqual(folders(closing.success.projects), ["/work/a", "/work/c"]);
		assert.deepStrictEqual(folders(projects), ["/work/a", "/work/b", "/work/c"]);
	});

	it("refuses to close a folder that is not open", () => {
		const closing = opened(OpenProjects.none, "/work/a").close("/work/z", undefined);
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
			recommends: [],
			recent: ["/work/b", "/work/a"],
		});
		const closing = projects.close("/work/a", undefined);
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(closing.success.projects.record, {
			version: 1,
			projects: [{folder: "/work/b"}],
			trusted: [],
			recommends: [],
			recent: ["/work/b", "/work/a"],
		});
	});

	it("keeps a trusted folder trusted across a close and a reopen, and records it", () => {
		const trusted = opened(OpenProjects.none, "/work/a").trust("/work/a").trust("/work/b");
		const closing = trusted.close("/work/a", undefined);
		if (Result.isFailure(closing)) throw closing.failure;
		const reopened = opened(closing.success.projects, "/work/a");
		assert.isTrue(reopened.trusted.trusts("/work/a"));
		assert.isTrue(reopened.trusted.trusts("/work/b/"));
		assert.deepStrictEqual(reopened.record, {
			version: 1,
			projects: [{folder: "/work/a"}],
			trusted: ["/work/a", "/work/b"],
			recommends: [],
			recent: ["/work/a"],
		});
	});

	it("restores a saved list's trust, and its open folders as pending, not open", () => {
		const restored = OpenProjects.restoring({
			version: 1,
			projects: [{folder: "/work/a"}, {folder: "/work/b"}, {folder: "/work/a/"}],
			trusted: ["/work/a"],
			recommends: [],
			recent: [],
		});
		assert.deepStrictEqual(restored.projects, []);
		assert.deepStrictEqual(restored.pending, ["/work/a", "/work/b"]);
		assert.isTrue(restored.trusted.trusts("/work/a"));
		assert.isFalse(OpenProjects.restoring(null).trusted.trusts("/work/a"));
		assert.deepStrictEqual(OpenProjects.restoring(null).pending, []);
	});

	it("keeps a pending folder in the record until it is opened or skipped", () => {
		const restored = OpenProjects.restoring({
			version: 1,
			projects: [{folder: "/work/a"}, {folder: "/work/b"}, {folder: "/work/c"}],
			trusted: [],
			recommends: [],
			recent: [],
		});
		// The boot project opens first, whether or not the list had it.
		const booted = opened(restored, "/work/z");
		assert.deepStrictEqual(
			booted.record.projects.map(({folder}) => folder),
			["/work/z", "/work/a", "/work/b", "/work/c"],
		);
		const reopened = opened(booted, "/work/b/");
		assert.deepStrictEqual(reopened.pending, ["/work/a", "/work/c"]);
		const skipped = reopened.skip("/work/a").skip("/work/c");
		assert.deepStrictEqual(skipped.pending, []);
		assert.deepStrictEqual(
			skipped.record.projects.map(({folder}) => folder),
			["/work/z", "/work/b"],
		);
		assert.strictEqual(skipped.skip("/work/a"), skipped);
	});

	it("keeps a project's recommend answers across its close, and restores them from the record", () => {
		const answered = opened(OpenProjects.none, "/work/demlik").answerRecommend(
			"/work/demlik",
			"tuval-cron",
			"decline",
		);
		const closing = answered.close("/work/demlik", undefined);
		if (Result.isFailure(closing)) throw closing.failure;
		const {record} = closing.success.projects;
		assert.deepStrictEqual(record.recommends, [
			{folder: "/work/demlik", answers: {"tuval-cron": "decline"}},
		]);
		const restored = OpenProjects.restoring(record);
		assert.deepStrictEqual(restored.recommends.unasked("/work/demlik", ["tuval-cron"]), []);
	});

	it("carries the pending folders across a trust and a close", () => {
		const restored = opened(
			OpenProjects.restoring({
				version: 1,
				projects: [{folder: "/work/a"}],
				trusted: [],
				recommends: [],
				recent: [],
			}),
			"/work/z",
		);
		const closing = restored.trust("/work/q").close("/work/z", undefined);
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(closing.success.projects.pending, ["/work/a"]);
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
				recommends: [],
				recent: ["/work/b", "/work/a"],
			});
			yield* saveOpenProjects(home, OpenProjects.none.trust("/work/c"));
			assert.deepStrictEqual(yield* readOpenProjects(home), {
				version: 1,
				projects: [],
				trusted: ["/work/c"],
				recommends: [],
				recent: [],
			});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("reads a list written before trust or recency was recorded as holding neither", () =>
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
				recommends: [],
				recent: [],
			});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

describe("recent projects", () => {
	it("lists the folders opened most recently first, a closed one still listed and not open", () => {
		const projects = opened(opened(opened(OpenProjects.none, "/work/a"), "/work/b"), "/work/c");
		const closing = projects.close("/work/b", undefined);
		if (Result.isFailure(closing)) throw closing.failure;
		assert.deepStrictEqual(
			closing.success.projects.recentProjects.map(({folder, open}) => ({folder, open})),
			[
				{folder: "/work/c", open: true},
				{folder: "/work/b", open: false},
				{folder: "/work/a", open: true},
			],
		);
	});

	it("moves a reopened folder to the front, under any spelling, and lists it once", () => {
		const projects = opened(opened(OpenProjects.none, "/work/a"), "/work/b");
		const closing = projects.close("/work/a", undefined);
		if (Result.isFailure(closing)) throw closing.failure;
		const reopened = opened(closing.success.projects, "/work/a/");
		assert.deepStrictEqual(reopened.recent, ["/work/a", "/work/b"]);
		assert.strictEqual(reopened.recentProjects[0]?.id.key, ProjectId.of("/work/a").key);
	});

	it("keeps at most RECENT_LIMIT folders, dropping the oldest", () => {
		const folders = Array.from({length: RECENT_LIMIT + 3}, (_, index) => `/work/p${index}`);
		const projects = folders.reduce(opened, OpenProjects.none);
		assert.strictEqual(projects.recent.length, RECENT_LIMIT);
		assert.strictEqual(projects.recent[0], `/work/p${RECENT_LIMIT + 2}`);
		assert.notInclude(projects.recent, "/work/p0");
	});

	it("never lists a subproject as recent, because its opener brings it back", () => {
		const parent = opened(OpenProjects.none, "/work/a");
		const nested = parent.openUnder("/work/a/lane", "/work/a", ProcessId.make("opener"));
		if (Result.isFailure(nested)) throw nested.failure;
		assert.deepStrictEqual(nested.success.projects.recent, ["/work/a"]);
	});

	it("restores the saved recent folders in their order, a folder listed twice counted once", () => {
		const restored = OpenProjects.restoring({
			version: 1,
			projects: [],
			trusted: [],
			recommends: [],
			recent: ["/work/b", "/work/a", "/work/b/"],
		});
		assert.deepStrictEqual(restored.recent, ["/work/b", "/work/a"]);
		assert.isTrue(restored.recentProjects.every((project) => !project.open));
	});
});
