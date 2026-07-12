/**
 * `checkFanout` over a fake repo dir — the filesystem-seam test (ADR 0155, #1898,
 * #2554). The pure verdict (drift, missing-publish, zero-scope, topic-mismatch) is
 * covered in `fanout-guard.unit.test.ts`; this crosses the IO gate over a real temp dir,
 * asserting the exit-code contract from observable outcomes — never by spawning the bin.
 *
 * The fixture pair is the working proof: a feature whose fanned mutation references the
 * publisher AND aims a live.ts binding at its declared topic SUCCEEDS; break either
 * (drop the publisher, or re-aim the topic) and it `CheckFailed`.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkFanout} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fanout-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const FEATURES = join("apps", "web", "worker", "features");

/** The `LiveTopic` map, written to the protocol file the gate resolves topic refs against. */
const writeProtocol = () => {
	const dir = join(root, FEATURES, "fate-live");
	mkdirSync(dir, {recursive: true});
	writeFileSync(
		join(dir, "protocol.ts"),
		'export const LiveTopic = {\n\tposts: "posts",\n\tpostComments: "Post.comments",\n} as const;\n',
		"utf8",
	);
};

interface ManifestRow {
	readonly key: string;
	readonly fanned: boolean;
	readonly topics?: ReadonlyArray<string>;
}
const writeManifest = (rows: ReadonlyArray<ManifestRow>) => {
	const dir = join(root, FEATURES, "fate-live");
	mkdirSync(dir, {recursive: true});
	const body = rows
		.map((r) => {
			const topics = r.topics ? ` topics: [${r.topics.map((t) => `"${t}"`).join(", ")}],` : "";
			return `\t{key: "${r.key}", fanned: ${r.fanned},${topics} rationale: "x"},`;
		})
		.join("\n");
	writeFileSync(
		join(dir, "fanned-mutations.ts"),
		`export const FANNED_MUTATIONS = [\n${body}\n];\n`,
		"utf8",
	);
};

/**
 * Write a feature's `mutations.ts` (its keys + whether it references the publisher) and,
 * optionally, a `live.ts` whose text carries the given topic/delegation references so the
 * gate's target scan can reach them.
 */
const writeFeature = (
	feature: string,
	keys: ReadonlyArray<string>,
	publishes: boolean,
	live?: string,
) => {
	const dir = join(root, FEATURES, feature);
	mkdirSync(dir, {recursive: true});
	const decls = keys.map((k) => `\t"${k}": Fate.mutation({}, fn),`).join("\n");
	const publishLine = publishes ? "\tconst live = featLive(yield* WorkerLivePublisher);\n" : "";
	writeFileSync(
		join(dir, "mutations.ts"),
		`export const mutations = {\n${decls}\n};\n${publishLine}`,
		"utf8",
	);
	if (live !== undefined) writeFileSync(join(dir, "live.ts"), live, "utf8");
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkFanout — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when a fanned mutation publishes AND its live.ts aims at the declared topic (the proof)", async () => {
		writeProtocol();
		writeManifest([{key: "post.submit", fanned: true, topics: ["posts"]}]);
		writeFeature("pano", ["post.submit"], true, "live.topic(LiveTopic.posts);");
		const exit = await run(checkFanout(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when a fanned mutation's feature omits the publisher (the falsification)", async () => {
		writeProtocol();
		writeManifest([{key: "post.submit", fanned: true, topics: ["posts"]}]);
		writeFeature("pano", ["post.submit"], false, "live.topic(LiveTopic.posts);");
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, topic-mismatch) when live.ts no longer aims at the declared topic", async () => {
		writeProtocol();
		writeManifest([{key: "comment.add", fanned: true, topics: ["Post.comments"]}]);
		// live.ts targets only `posts` — the Post.comments aim was edited away
		writeFeature("pano", ["comment.add"], true, "live.topic(LiveTopic.posts);");
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, topic-mismatch) when a fanned mutation declares NO topic", async () => {
		writeProtocol();
		writeManifest([{key: "post.submit", fanned: true}]);
		writeFeature("pano", ["post.submit"], true, "live.topic(LiveTopic.posts);");
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("SUCCEEDS when a feature reaches its declared topic THROUGH a delegated *Live binding", async () => {
		writeProtocol();
		writeManifest([
			{key: "post.submit", fanned: true, topics: ["posts"]},
			{key: "report.resolve", fanned: true, topics: ["posts"]},
		]);
		writeFeature("pano", ["post.submit"], true, "live.topic(LiveTopic.posts);");
		// report/live.ts has no direct topic; it publishes THROUGH panoLive(...)
		writeFeature("report", ["report.resolve"], true, "const p = panoLive(live);");
		const exit = await run(checkFanout(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("SUCCEEDS for a not-fanned mutation whose feature omits the publisher", async () => {
		writeProtocol();
		writeManifest([{key: "bildirim.markRead", fanned: false}]);
		writeFeature("bildirim", ["bildirim.markRead"], false);
		const exit = await run(checkFanout(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, drift) when a discovered mutation has no manifest row", async () => {
		writeProtocol();
		writeManifest([{key: "post.submit", fanned: true, topics: ["posts"]}]);
		writeFeature("pano", ["post.submit", "post.newthing"], true, "live.topic(LiveTopic.posts);");
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) when zero mutations are discovered", async () => {
		writeProtocol();
		writeManifest([{key: "post.submit", fanned: true, topics: ["posts"]}]);
		// a feature dir with no mutations.ts ⇒ zero discovered
		mkdirSync(join(root, FEATURES, "empty"), {recursive: true});
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) when the manifest is empty", async () => {
		writeProtocol();
		mkdirSync(join(root, FEATURES, "fate-live"), {recursive: true});
		writeFileSync(
			join(root, FEATURES, "fate-live", "fanned-mutations.ts"),
			"export const FANNED_MUTATIONS = [];\n",
			"utf8",
		);
		writeFeature("pano", ["post.submit"], true, "live.topic(LiveTopic.posts);");
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
