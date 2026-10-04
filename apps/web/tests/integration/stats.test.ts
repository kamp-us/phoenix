/**
 * landing stats — black-box against the deployed worker `/fate` route
 * (ADR 0026–0031).
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1
 * is shared across every migrated file — concurrent writers can only INFLATE the global
 * `landingStats` counters between this file's snapshots. Every assertion here is a
 * lower-bound `>=` DELTA (snapshot `landingStats`, create N definitions + M posts + K
 * comments under a fresh cookie, snapshot again, assert each counter rose by AT LEAST the
 * amount we added), which is monotone-safe under that inflation — a concurrent add only
 * widens the gap, never narrows it, so no `>=` ever breaks. The delta form is independent
 * of the absolute baseline, which is never fixed (the harness seeds its own author/voter
 * users for sign-up and seeding).
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

interface LandingStats {
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
}

const STATS_SELECT = ["totalDefinitions", "totalPosts", "totalComments", "totalAuthors"];

async function landingStats(): Promise<LandingStats> {
	const result = await h.fate({kind: "query", name: "landingStats", select: STATS_SELECT});
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`landingStats failed: ${JSON.stringify(result)}`);
	return result.data as LandingStats;
}

let author: {userId: string; cookie: string};

beforeAll(async () => {
	author = await h.signUpYazar(`${NS}-author@test.local`, "hunter2hunter2", "Stats Author");
});

describe("landing stats — /fate", () => {
	it("each counter increases by AT LEAST the amount added under a fresh author", async () => {
		const before = await landingStats();

		for (let i = 0; i < 2; i++) {
			const def = await h.fate(
				{
					kind: "mutation",
					name: "definition.add",
					input: {termSlug: `${NS}-def-${i}`, body: `stats definition ${i}`},
					select: ["id"],
				},
				{cookie: author.cookie},
			);
			expect(def.ok).toBe(true);
		}

		const post = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: `${NS} a post`, tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(post.ok).toBe(true);
		if (!post.ok) return;
		const postId = (post.data as {id: string}).id;

		for (let i = 0; i < 3; i++) {
			const comment = await h.fate(
				{
					kind: "mutation",
					name: "comment.add",
					input: {postId, body: `stats comment ${i}`},
					select: ["id"],
				},
				{cookie: author.cookie},
			);
			expect(comment.ok).toBe(true);
		}

		const after = await landingStats();

		expect(after.totalDefinitions).toBeGreaterThanOrEqual(before.totalDefinitions + 2);
		expect(after.totalPosts).toBeGreaterThanOrEqual(before.totalPosts + 1);
		expect(after.totalComments).toBeGreaterThanOrEqual(before.totalComments + 3);
		// Our fresh author contributed across all three feeds → distinct-author
		// count is monotonic and rose by at least our one new author.
		expect(after.totalAuthors).toBeGreaterThanOrEqual(before.totalAuthors + 1);
	});

	// The decrement a delete makes is not observable here: a lower-bound delta on a shared,
	// only-inflating counter cannot show a -1. The recompute is unit-tested
	// (`recompute-sozluk-stats-public-live.unit.test.ts`), and the term-level decrement on real D1
	// by `sozluk-mutations.test.ts`.
});
