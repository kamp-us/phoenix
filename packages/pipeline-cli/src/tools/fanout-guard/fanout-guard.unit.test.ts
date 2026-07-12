/**
 * Pure-core tests for `fanout-guard` (ADR 0155, #1898, #2554): the drift check (a
 * mutation must be classified), the fanned-must-publish check (the fixture pair — a
 * fanned mutation with a publish passes, one without fails), the topic-aim check (a
 * fanned mutation must declare a topic its feature's live.ts reaches), the
 * fail-closed-on-zero verdict (ADR 0092), and the manifest/mutation-key/publisher/
 * topic/delegation source parses. No IO — the filesystem seam is crossed in
 * `gate.unit.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type DiscoveredMutation,
	type FanoutGuardFacts,
	type FeatureTargets,
	judge,
	type ManifestEntry,
	parseFeatureDelegations,
	parseFeatureTargets,
	parseLiveTopicMap,
	parseManifestEntries,
	parseMutationKeys,
	referencesPublisher,
	renderReport,
	resolveReachableTargets,
} from "./fanout-guard.ts";

const disc = (key: string, feature: string): DiscoveredMutation => ({key, feature});
const man = (key: string, fanned: boolean, topics: ReadonlyArray<string> = []): ManifestEntry => ({
	key,
	fanned,
	topics,
});
const targets = (pairs: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): FeatureTargets =>
	new Map(pairs.map(([f, t]) => [f, new Set(t)]));
const facts = (
	discovered: ReadonlyArray<DiscoveredMutation>,
	manifest: ReadonlyArray<ManifestEntry>,
	featurePublishes: ReadonlyMap<string, boolean>,
	featureTargets: FeatureTargets = new Map(),
): FanoutGuardFacts => ({discovered, manifest, featurePublishes, featureTargets});

describe("judge — fail-closed on zero scope (ADR 0092)", () => {
	it("FAILS with zero-scope when no mutations are discovered", () => {
		const verdict = judge(facts([], [man("post.submit", true, ["posts"])], new Map()));
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason).toBe("zero-scope");
	});
});

describe("judge — drift (every mutation must be classified)", () => {
	it("FAILS with an unclassified discovered mutation", () => {
		const verdict = judge(facts([disc("post.submit", "pano")], [], new Map([["pano", true]])));
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason === "drift" && verdict.unclassified).toEqual([
			"post.submit",
		]);
	});

	it("FAILS with a stale manifest row for a mutation that no longer exists", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano")],
				[man("post.submit", true, ["posts"]), man("post.gone", true, ["posts"])],
				new Map([["pano", true]]),
				targets([["pano", ["posts"]]]),
			),
		);
		expect(verdict.pass).toBe(false);
		expect(verdict.pass === false && verdict.reason === "drift" && verdict.stale).toEqual([
			"post.gone",
		]);
	});
});

describe("judge — the fixture pair: a fanned mutation must publish", () => {
	it("PASSES when a fanned mutation's feature references a publish AND aims at its topic", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano")],
				[man("post.submit", true, ["posts"])],
				new Map([["pano", true]]),
				targets([["pano", ["posts"]]]),
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.fanned).toBe(1);
	});

	it("FAILS when a fanned mutation's feature omits the publish", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano")],
				[man("post.submit", true, ["posts"])],
				// pano does NOT reference the publisher — the omission the guard exists to catch
				new Map([["pano", false]]),
				targets([["pano", ["posts"]]]),
			),
		);
		expect(verdict.pass).toBe(false);
		expect(
			verdict.pass === false && verdict.reason === "missing-publish" && verdict.omitted,
		).toEqual(["post.submit"]);
	});

	it("a NOT-fanned mutation whose feature omits the publish is fine", () => {
		const verdict = judge(
			facts(
				[disc("bildirim.markRead", "bildirim")],
				[man("bildirim.markRead", false)],
				new Map([["bildirim", false]]),
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.fanned).toBe(0);
	});

	it("mixed feature: a fanned + a non-fanned mutation share one publishing feature — passes", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano"), disc("post.saveDraft", "pano")],
				[man("post.submit", true, ["posts"]), man("post.saveDraft", false)],
				new Map([["pano", true]]),
				targets([["pano", ["posts"]]]),
			),
		);
		expect(verdict.pass).toBe(true);
		expect(verdict.pass && verdict.checked).toBe(2);
		expect(verdict.pass && verdict.fanned).toBe(1);
	});
});

describe("judge — topic aim (#2554): a fanned mutation must publish to its declared topic", () => {
	it("PASSES when the declared topic is reachable from the feature's live.ts", () => {
		const verdict = judge(
			facts(
				[disc("comment.add", "pano")],
				[man("comment.add", true, ["Post.comments"])],
				new Map([["pano", true]]),
				targets([["pano", ["posts", "Post.comments", "Post", "Comment"]]]),
			),
		);
		expect(verdict.pass).toBe(true);
	});

	it("FAILS (topic-mismatch, mis-aimed) when the declared topic is NOT reachable — the wrong-topic edit", () => {
		const verdict = judge(
			facts(
				[disc("comment.add", "pano")],
				[man("comment.add", true, ["Post.comments"])],
				new Map([["pano", true]]),
				// pano/live.ts was re-aimed and no longer targets Post.comments
				targets([["pano", ["posts", "Post"]]]),
			),
		);
		expect(verdict.pass).toBe(false);
		if (verdict.pass === false && verdict.reason === "topic-mismatch") {
			expect(verdict.misaimed).toEqual([
				{
					key: "comment.add",
					feature: "pano",
					declared: ["Post.comments"],
					unreachable: ["Post.comments"],
				},
			]);
			expect(verdict.undeclared).toEqual([]);
		} else {
			expect.unreachable("expected topic-mismatch verdict");
		}
	});

	it("FAILS (topic-mismatch, undeclared) when a fanned mutation declares NO topic — parity with drift", () => {
		const verdict = judge(
			facts(
				[disc("post.submit", "pano")],
				[man("post.submit", true)],
				new Map([["pano", true]]),
				targets([["pano", ["posts"]]]),
			),
		);
		expect(verdict.pass).toBe(false);
		expect(
			verdict.pass === false && verdict.reason === "topic-mismatch" && verdict.undeclared,
		).toEqual(["post.submit"]);
	});

	it("a mutation with multiple declared topics passes only when ALL are reachable", () => {
		const declared = man("post.delete", true, ["Post", "posts"]);
		const reachable = judge(
			facts(
				[disc("post.delete", "pano")],
				[declared],
				new Map([["pano", true]]),
				targets([["pano", ["posts", "Post"]]]),
			),
		);
		expect(reachable.pass).toBe(true);

		const partial = judge(
			facts(
				[disc("post.delete", "pano")],
				[declared],
				new Map([["pano", true]]),
				targets([["pano", ["Post"]]]),
			),
		);
		expect(partial.pass).toBe(false);
		expect(
			partial.pass === false &&
				partial.reason === "topic-mismatch" &&
				partial.misaimed[0]?.unreachable,
		).toEqual(["posts"]);
	});

	it("a delegated feature (report → pano/sözlük) reaches its declared topics through the closure", () => {
		const verdict = judge(
			facts(
				[disc("report.resolve", "report")],
				[man("report.resolve", true, ["Post", "Term.definitions"])],
				new Map([["report", true]]),
				// report/live.ts has no direct targets; the closure gave it pano ∪ sözlük
				targets([["report", ["posts", "Post.comments", "Post", "Comment", "Term.definitions"]]]),
			),
		);
		expect(verdict.pass).toBe(true);
	});
});

describe("renderReport", () => {
	it("names the omitting mutations on a missing-publish fail", () => {
		const report = renderReport({
			pass: false,
			reason: "missing-publish",
			omitted: ["report.resolve"],
		});
		expect(report).toContain("report.resolve");
		expect(report).toContain("WorkerLivePublisher");
	});

	it("names the unclassified mutations on a drift fail", () => {
		const report = renderReport({
			pass: false,
			reason: "drift",
			unclassified: ["post.newthing"],
			stale: [],
		});
		expect(report).toContain("post.newthing");
		expect(report).toContain("UNCLASSIFIED");
	});

	it("surfaces both undeclared and mis-aimed rows legibly on a topic-mismatch fail", () => {
		const report = renderReport({
			pass: false,
			reason: "topic-mismatch",
			undeclared: ["post.newfan"],
			misaimed: [
				{
					key: "comment.add",
					feature: "pano",
					declared: ["Post.comments"],
					unreachable: ["Post.comments"],
				},
			],
		});
		expect(report).toContain("UNDECLARED-TOPIC");
		expect(report).toContain("post.newfan");
		expect(report).toContain("MIS-AIMED");
		expect(report).toContain("comment.add");
		expect(report).toContain("Post.comments");
	});
});

describe("parseManifestEntries — read {key, fanned, topics} rows from manifest source", () => {
	it("parses a fanned row's topics and a not-fanned row (no topics ⇒ [])", () => {
		const source = `
			export const FANNED_MUTATIONS = [
				{key: "post.submit", fanned: true, topics: ["posts"], rationale: "prepends a Post edge"},
				{key: "post.delete", fanned: true, topics: ["Post", "posts"], rationale: "drops the edge"},
				{key: "bildirim.markRead", fanned: false, rationale: "per-user, no connection"},
			];
		`;
		expect(parseManifestEntries(source)).toEqual([
			{key: "post.submit", fanned: true, topics: ["posts"]},
			{key: "post.delete", fanned: true, topics: ["Post", "posts"]},
			{key: "bildirim.markRead", fanned: false, topics: []},
		]);
	});

	it("a fanned row that OMITS topics parses to [] (the guard then flags it undeclared)", () => {
		const source = `{key: "post.submit", fanned: true, rationale: "oops, no topics"},`;
		expect(parseManifestEntries(source)).toEqual([{key: "post.submit", fanned: true, topics: []}]);
	});

	it("returns [] on an empty/unparseable manifest (gate.ts fails closed on this)", () => {
		expect(parseManifestEntries("export const FANNED_MUTATIONS = [];")).toEqual([]);
	});
});

describe("parseMutationKeys — read Fate.mutation keys from mutations.ts source", () => {
	it('matches the `"entity.verb": Fate.mutation(` declaration shape', () => {
		const source = `
			export const mutations = {
				"post.submit": Fate.mutation({ ... }),
				"comment.add": Fate.mutation(
					{ ... },
				),
			};
		`;
		expect(parseMutationKeys(source)).toEqual(["post.submit", "comment.add"]);
	});

	it("returns [] when a feature declares no mutations", () => {
		expect(parseMutationKeys("export const mutations = {};")).toEqual([]);
	});
});

describe("referencesPublisher — feature-scoped publish detection", () => {
	it("true when the source reaches WorkerLivePublisher", () => {
		expect(referencesPublisher("const live = panoLive(yield* WorkerLivePublisher);")).toBe(true);
	});

	it("false when the source never mentions the publisher", () => {
		expect(referencesPublisher("const marked = yield* bildirim.markRead(user.id, input.id);")).toBe(
			false,
		);
	});
});

describe("parseLiveTopicMap — resolve LiveTopic.<prop> to its wire value", () => {
	it("parses the object entries, ignoring interspersed docblock prose", () => {
		const source = `
			export const LiveTopic = {
				/** pano feed (no-args, global). */
				posts: "posts",
				/** pano post → comments (args: \`{id: postId}\`). */
				postComments: "Post.comments",
				termDefinitions: "Term.definitions",
			} as const;
		`;
		const map = parseLiveTopicMap(source);
		expect(map.get("posts")).toBe("posts");
		expect(map.get("postComments")).toBe("Post.comments");
		expect(map.get("termDefinitions")).toBe("Term.definitions");
		expect(map.size).toBe(3);
	});

	it("returns an empty map when the LiveTopic block is absent", () => {
		expect(parseLiveTopicMap("export const Other = {a: 1};").size).toBe(0);
	});
});

describe("parseFeatureTargets — the /fate/live targets a live.ts binding reaches directly", () => {
	const map = new Map([
		["posts", "posts"],
		["postComments", "Post.comments"],
		["termDefinitions", "Term.definitions"],
	]);

	it("resolves LiveTopic.<prop> refs and <Entity>View.typeName refs", () => {
		const live = `
			const POST = PostView.typeName;
			const COMMENT = CommentView.typeName;
			live.topic(LiveTopic.posts);
			live.topic(LiveTopic.postComments, {id});
		`;
		expect([...parseFeatureTargets(live, map)].sort()).toEqual([
			"Comment",
			"Post",
			"Post.comments",
			"posts",
		]);
	});

	it("ignores an unknown LiveTopic prop and a bare <Name>View without .typeName", () => {
		const live = "live.topic(LiveTopic.mystery); const V = SomeView; PostView.typeName;";
		expect([...parseFeatureTargets(live, map)]).toEqual(["Post"]);
	});
});

describe("parseFeatureDelegations — the *Live( bindings a feature publishes through", () => {
	it("captures delegated feature bindings, not WorkerLivePublisher", () => {
		const live = `
			const pano = panoLive(live, feedCache);
			const sozluk = sozlukLive(live);
			const p = yield* WorkerLivePublisher;
		`;
		expect([...parseFeatureDelegations(live)].sort()).toEqual(["pano", "sozluk"]);
	});

	it("does not capture its own export def (name = ( with no immediate call)", () => {
		expect([...parseFeatureDelegations("export const reportLive = (live) => ({});")]).toEqual([]);
	});
});

describe("resolveReachableTargets — union direct targets with delegated ones, transitively", () => {
	it("report inherits pano ∪ sözlük through delegation", () => {
		const direct = new Map<string, ReadonlySet<string>>([
			["pano", new Set(["posts", "Post"])],
			["sozluk", new Set(["Term.definitions", "Definition"])],
			["report", new Set()],
		]);
		const delegations = new Map<string, ReadonlySet<string>>([
			["report", new Set(["pano", "sozluk"])],
		]);
		const resolved = resolveReachableTargets(direct, delegations);
		expect([...(resolved.get("report") ?? [])].sort()).toEqual([
			"Definition",
			"Post",
			"Term.definitions",
			"posts",
		]);
		// a non-delegating feature is unchanged
		expect([...(resolved.get("pano") ?? [])].sort()).toEqual(["Post", "posts"]);
	});

	it("self-delegation is a no-op and does not loop", () => {
		const direct = new Map<string, ReadonlySet<string>>([["pano", new Set(["posts"])]]);
		const delegations = new Map<string, ReadonlySet<string>>([["pano", new Set(["pano"])]]);
		expect([...(resolveReachableTargets(direct, delegations).get("pano") ?? [])]).toEqual([
			"posts",
		]);
	});
});
