/**
 * The optimistic-vs-round-trip membership branch for `post.submit` (#1676, epic
 * #1637), tested off the pure {@link postSubmitMembership} core — no DOM, mirroring
 * `flagGateChild` / `resolveFlagResponse`. Covers the containment flag on/off
 * paths and the optimistic node's no-phantom-self-upvote contract (#707).
 */
import {assert, describe, it} from "@effect/vitest";
import {type OptimisticSubmitInput, postSubmitMembership} from "./panoSubmitArgs";

const NOW = new Date("2026-07-02T00:00:00.000Z");

const linkInput: OptimisticSubmitInput = {
	title: "bir başlık",
	url: "https://overreacted.io/x",
	host: "overreacted.io",
	tags: ["link", "soru"],
	author: "umut",
	authorId: "user-1",
	now: NOW,
};

describe("postSubmitMembership — flag-gated optimistic feed insert", () => {
	it("flag off ⇒ plain round-trip: insert none, no optimistic node", () => {
		const args = postSubmitMembership(false, linkInput);
		assert.deepStrictEqual(args, {insert: "none"});
		assert.strictEqual("optimistic" in args, false);
	});

	it("flag on ⇒ prepends an optimistic temp-id node for root-list reconcile", () => {
		const args = postSubmitMembership(true, linkInput);
		assert.strictEqual(args.insert, "before");
		if (args.insert !== "before") return;
		const o = args.optimistic;
		assert.strictEqual(o.id, `optimistic:${NOW.getTime()}`);
		assert.ok(o.id.startsWith("optimistic:"), "temp id fate reconciles to the server id");
		assert.strictEqual(o.slug, null);
		assert.strictEqual(o.title, "bir başlık");
		assert.strictEqual(o.url, "https://overreacted.io/x");
		assert.strictEqual(o.host, "overreacted.io");
		assert.strictEqual(o.author, "umut");
		assert.strictEqual(o.authorId, "user-1");
		assert.strictEqual(o.createdAt, NOW);
	});

	it("the optimistic node is score 0 / no vote — never a phantom self-upvote (#707)", () => {
		const args = postSubmitMembership(true, linkInput);
		if (args.insert !== "before") throw new Error("expected optimistic branch");
		assert.strictEqual(args.optimistic.score, 0);
		assert.strictEqual(args.optimistic.myVote, null);
		assert.strictEqual(args.optimistic.commentCount, 0);
	});

	it("maps selected tag kinds to {kind,label} pairs", () => {
		const args = postSubmitMembership(true, linkInput);
		if (args.insert !== "before") throw new Error("expected optimistic branch");
		assert.deepStrictEqual(args.optimistic.tags, [
			{kind: "link", label: "link"},
			{kind: "soru", label: "soru"},
		]);
	});

	it("text mode (no link) carries null url/host", () => {
		const args = postSubmitMembership(true, {...linkInput, url: null, host: null});
		if (args.insert !== "before") throw new Error("expected optimistic branch");
		assert.strictEqual(args.optimistic.url, null);
		assert.strictEqual(args.optimistic.host, null);
	});
});
