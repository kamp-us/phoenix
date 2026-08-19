/**
 * `guard fanout-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem — the
 * `gate.unit.test.ts` cases from the v1 CLI, re-seated on the three guard exit codes.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runFanoutGuard} from "./fanout-verb.ts";

const ROOT = "/repo";
const FEATURES = `${ROOT}/apps/web/worker/features`;
const MANIFEST = `${FEATURES}/fate-live/fanned-mutations.ts`;
const PROTOCOL = `${FEATURES}/fate-live/protocol.ts`;

const PROTOCOL_SOURCE =
	'export const LiveTopic = {\n\tposts: "posts",\n\tpostComments: "Post.comments",\n} as const;\n';

interface ManifestRow {
	readonly key: string;
	readonly fanned: boolean;
	readonly topics?: ReadonlyArray<string>;
}

const manifestSource = (rows: ReadonlyArray<ManifestRow>): string =>
	`export const FANNED_MUTATIONS = [\n${rows
		.map((r) => {
			const topics = r.topics ? ` topics: [${r.topics.map((t) => `"${t}"`).join(", ")}],` : "";
			return `\t{key: "${r.key}", fanned: ${r.fanned},${topics} rationale: "x"},`;
		})
		.join("\n")}\n];\n`;

interface Feature {
	readonly name: string;
	readonly keys?: ReadonlyArray<string>;
	readonly publishes?: boolean;
	readonly live?: string;
}

/** A repo tree holding the fate-live manifest + protocol and one dir per feature. */
const tree = (
	rows: ReadonlyArray<ManifestRow>,
	features: ReadonlyArray<Feature>,
	options: {readonly protocol?: boolean; readonly manifest?: string} = {},
): FakeFsOptions => {
	const files: Record<string, string> = {
		[MANIFEST]: options.manifest ?? manifestSource(rows),
	};
	if (options.protocol !== false) files[PROTOCOL] = PROTOCOL_SOURCE;
	const directories = [`${FEATURES}/fate-live`];
	for (const feature of features) {
		directories.push(`${FEATURES}/${feature.name}`);
		if (feature.keys !== undefined) {
			const decls = feature.keys.map((k) => `\t"${k}": Fate.mutation({}, fn),`).join("\n");
			const publish =
				feature.publishes === true ? "\tconst live = featLive(yield* WorkerLivePublisher);\n" : "";
			files[`${FEATURES}/${feature.name}/mutations.ts`] =
				`export const mutations = {\n${decls}\n};\n${publish}`;
		}
		if (feature.live !== undefined) files[`${FEATURES}/${feature.name}/live.ts`] = feature.live;
	}
	return {
		files,
		directories,
		dirs: {[FEATURES]: ["fate-live", ...features.map((f) => f.name)]},
	};
};

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runFanoutGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

const PANO_AIMED = "live.topic(LiveTopic.posts);";

describe("runFanoutGuard", () => {
	// The working proof: publish present AND aimed at the declared topic.
	it("passes when a fanned mutation publishes and its live.ts aims at the declared topic", async () => {
		const outcome = await run(
			tree(
				[{key: "post.submit", fanned: true, topics: ["posts"]}],
				[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
			),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("1 mutations classified, 1 fanned");
		expect(outcome.stderr).toEqual([]);
	});

	it("passes a not-fanned mutation whose feature omits the publisher", async () => {
		const outcome = await run(
			tree(
				[{key: "bildirim.markRead", fanned: false}],
				[{name: "bildirim", keys: ["bildirim.markRead"], publishes: false}],
			),
		);
		expect(outcome.code).toBe(0);
	});

	it("passes when a feature reaches its declared topic THROUGH a delegated *Live binding", async () => {
		const outcome = await run(
			tree(
				[
					{key: "post.submit", fanned: true, topics: ["posts"]},
					{key: "report.resolve", fanned: true, topics: ["posts"]},
				],
				[
					{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED},
					{
						name: "report",
						keys: ["report.resolve"],
						publishes: true,
						live: "const p = panoLive(live);",
					},
				],
			),
		);
		expect(outcome.code).toBe(0);
	});

	it("reds a fanned mutation whose feature omits the publish, annotating its mutations.ts", async () => {
		const outcome = await run(
			tree(
				[{key: "post.submit", fanned: true, topics: ["posts"]}],
				[{name: "pano", keys: ["post.submit"], publishes: false, live: PANO_AIMED}],
			),
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("post.submit");
		expect(
			outcome.stderr.some((line) =>
				line.startsWith("::error file=apps/web/worker/features/pano/mutations.ts::"),
			),
		).toBe(true);
	});

	it("reds an unclassified mutation, annotating the manifest", async () => {
		const outcome = await run(
			tree(
				[{key: "post.submit", fanned: true, topics: ["posts"]}],
				[
					{
						name: "pano",
						keys: ["post.submit", "post.newthing"],
						publishes: true,
						live: PANO_AIMED,
					},
				],
			),
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("UNCLASSIFIED");
		expect(
			outcome.stderr.some((line) =>
				line.startsWith("::error file=apps/web/worker/features/fate-live/fanned-mutations.ts::"),
			),
		).toBe(true);
	});

	it("reds a stale manifest row", async () => {
		const outcome = await run(
			tree(
				[
					{key: "post.submit", fanned: true, topics: ["posts"]},
					{key: "post.gone", fanned: true, topics: ["posts"]},
				],
				[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
			),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("STALE");
	});

	// The #2554 edit: live.ts was re-aimed and no longer targets the declared topic.
	it("reds a mis-aimed publish", async () => {
		const outcome = await run(
			tree(
				[{key: "comment.add", fanned: true, topics: ["Post.comments"]}],
				[{name: "pano", keys: ["comment.add"], publishes: true, live: PANO_AIMED}],
			),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("MIS-AIMED");
	});

	it("reds a fanned mutation that declares no topic", async () => {
		const outcome = await run(
			tree(
				[{key: "post.submit", fanned: true}],
				[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
			),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("UNDECLARED-TOPIC");
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(
			tree(
				[{key: "post.submit", fanned: true, topics: ["posts"]}],
				[{name: "pano", keys: ["post.submit"], publishes: false, live: PANO_AIMED}],
			),
		);
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// ADR 0092's floor: nothing discovered means the guard proved nothing.
	it("fails closed when zero mutations are discovered", async () => {
		const outcome = await run(
			tree([{key: "post.submit", fanned: true, topics: ["posts"]}], [{name: "empty"}]),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO Fate.mutation");
	});

	it("fails closed when the manifest parses to zero rows", async () => {
		const outcome = await run(
			tree([], [{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}], {
				manifest: "export const FANNED_MUTATIONS = [];\n",
			}),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO rows");
	});

	// A moved protocol file leaves every declared connection topic unreachable — red, never green.
	it("reds every declared connection topic when the protocol file is absent", async () => {
		const outcome = await run(
			tree(
				[{key: "post.submit", fanned: true, topics: ["posts"]}],
				[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
				{protocol: false},
			),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("MIS-AIMED");
	});

	it("answers UNKNOWN when the manifest cannot be read", async () => {
		const base = tree(
			[{key: "post.submit", fanned: true, topics: ["posts"]}],
			[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
		);
		const outcome = await run({...base, unreadable: [MANIFEST]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when the features directory cannot be listed", async () => {
		const base = tree(
			[{key: "post.submit", fanned: true, topics: ["posts"]}],
			[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
		);
		const outcome = await run({...base, dirs: {}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("cannot read");
	});

	it("answers UNKNOWN when a feature's mutations.ts cannot be read", async () => {
		const base = tree(
			[{key: "post.submit", fanned: true, topics: ["posts"]}],
			[{name: "pano", keys: ["post.submit"], publishes: true, live: PANO_AIMED}],
		);
		const outcome = await run({...base, unreadable: [`${FEATURES}/pano/mutations.ts`]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("answers UNKNOWN when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runFanoutGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("no repo root");
	});
});
