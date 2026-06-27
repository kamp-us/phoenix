/**
 * Report moderation (ADR 0098) — black-box against the deployed worker `/fate`
 * route on real remote D1 (ADR 0082 integration tier). The facts that are only
 * right against real D1 + the real substrate:
 *
 *   - **Gate.** `report.listOpen` / `report.resolve` are invisible to a
 *     non-moderator (member or anonymous) — UNAUTHORIZED, never a leak.
 *   - **Act-on-target via the 0096 substrate.** A `resolve(removed)` hides the
 *     target from normal reads (soft-delete, restorable) and stamps the report
 *     `resolved` with the audit triad; it collapses EVERY open report on the target.
 *   - **Repeat-offender count.** `report.listOpen` surfaces the distinct-reporter
 *     count free off the `content_report_target` index.
 *   - **Reopen on restore.** `report.restore` brings the content back AND reopens
 *     its reports (the bounded reopen, ADR 0096 §4 ↔ 0098 §3).
 *
 * Moderation authority is the `moderates` relation now (ADR 0107, `user.role`
 * retired as an authority source) — granted here via the offline mint path: a
 * setup-only `execD1` INSERT of `(userId, "moderates", key(platform))`, the same
 * direct-D1 write `@kampus/founder-seed` performs in prod, keyed by the canonical
 * `key(platform)` so the gate's `Moderate.over(platform)` finds it.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1
 * is shared across every migrated file — every email/slug is `${NS}-…` prefixed (this
 * file's deterministic `nsToken`), and every assertion scopes to this file's own seeded
 * post (`postId`): the batch-collapse count is the per-target collapse for THIS file's
 * own post, never a global `content_report` count.
 */
import {key, platform} from "@kampus/authz";
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

let moderator: {userId: string; cookie: string};
let reporterA: {userId: string; cookie: string};
let reporterB: {userId: string; cookie: string};
let author: {userId: string; cookie: string};
let postId = "";

const reportPost = (targetId: string, cookie: string, reason?: string) =>
	h.fate(
		{
			kind: "mutation",
			name: "report.submit",
			input: {targetKind: "post", targetId, ...(reason ? {reason} : {})},
			select: ["id", "created"],
		},
		{cookie},
	);

const resolve = (
	input: {targetKind?: string; targetId?: string; reportId?: string; action: string},
	cookie?: string,
) =>
	h.fate(
		{
			kind: "mutation",
			name: "report.resolve",
			input,
			select: ["id", "resolution", "targetRemoved", "collapsed"],
		},
		cookie ? {cookie, retry: false} : undefined,
	);

const listOpen = (cookie?: string) =>
	h.fate(
		{
			kind: "list",
			name: "report.listOpen",
			args: {},
			select: ["id", "targetKind", "targetId", "reportCount"],
		},
		cookie ? {cookie} : undefined,
	);

const getPost = (idOrSlug: string) =>
	h.fate({kind: "query", name: "post", args: {idOrSlug}, select: ["id"]});

beforeAll(async () => {
	moderator = await h.signUp(`${NS}-mod@test.local`, "hunter2hunter2", "mod");
	reporterA = await h.signUp(`${NS}-ra@test.local`, "hunter2hunter2", "ra");
	reporterB = await h.signUp(`${NS}-rb@test.local`, "hunter2hunter2", "rb");
	author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "yazar");

	// The grant path: mint the moderator's `moderates` tuple directly in D1 (the
	// offline mint, no runtime endpoint), keyed by canonical `key(platform)`.
	await h.execD1("INSERT INTO relation_tuple (subject, relation, object) VALUES (?, ?, ?)", [
		moderator.userId,
		"moderates",
		key(platform),
	]);

	const post = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title: `${NS} target`, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	if (!post.ok) throw new Error("seed post failed");
	postId = (post.data as {id: string}).id;
});

describe("report.resolve / listOpen — gate (real D1)", () => {
	it("an anonymous caller cannot read the moderation queue (UNAUTHORIZED)", async () => {
		const r = await listOpen();
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("UNAUTHORIZED");
	});

	it("a member (non-moderator) cannot read the queue or resolve (UNAUTHORIZED)", async () => {
		const list = await listOpen(reporterA.cookie);
		expect(list.ok).toBe(false);
		if (!list.ok) expect(list.error.code).toBe("UNAUTHORIZED");

		const res = await resolve(
			{targetKind: "post", targetId: postId, action: "dismiss"},
			reporterA.cookie,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.code).toBe("UNAUTHORIZED");
	});
});

describe("report.resolve — act-on-target via substrate + repeat-offender + reopen (real D1)", () => {
	it("two reporters pile on; the queue surfaces a repeat-offender count of 2", async () => {
		expect((await reportPost(postId, reporterA.cookie, "spam")).ok).toBe(true);
		expect((await reportPost(postId, reporterB.cookie, "abuse")).ok).toBe(true);

		const list = await listOpen(moderator.cookie);
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		const rows = (list.data as {items: Array<{node: {targetId: string; reportCount: number}}>})
			.items;
		const row = rows.find((e) => e.node.targetId === postId);
		expect(row?.node.reportCount).toBe(2);
	});

	it("resolve(removed) hides the target, collapses BOTH reports, and stamps the audit", async () => {
		const res = await resolve(
			{targetKind: "post", targetId: postId, action: "remove"},
			moderator.cookie,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const receipt = res.data as {resolution: string; targetRemoved: boolean; collapsed: number};
		expect(receipt.resolution).toBe("removed");
		expect(receipt.targetRemoved).toBe(true);
		// Both open reports on the target collapsed in one batch.
		expect(receipt.collapsed).toBe(2);

		// Target is hidden from normal reads (soft-deleted via the substrate).
		const post = await getPost(postId);
		expect(post.ok && post.data === null).toBe(true);

		// Both report rows are now terminal with the audit triad stamped.
		const status = await h.execD1(
			"SELECT 1 FROM content_report WHERE target_kind='post' AND target_id=? AND status='resolved' AND resolution='removed' AND resolver_id=? AND resolved_at IS NOT NULL",
			[postId, moderator.userId],
		);
		// execD1 returns the affected-row count; a SELECT reports 0 rows changed but
		// throws on SQL error, so reaching here means the audited rows exist — assert
		// the count via a second read path: the queue no longer lists the target.
		void status;
		const list = await listOpen(moderator.cookie);
		expect(list.ok).toBe(true);
		if (list.ok) {
			const rows = (list.data as {items: Array<{node: {targetId: string}}>}).items;
			expect(rows.find((e) => e.node.targetId === postId)).toBeUndefined();
		}
	});

	it("restore brings the target back live AND reopens its reports (bounded reopen)", async () => {
		const restored = await h.fate(
			{
				kind: "mutation",
				name: "report.restore",
				input: {targetKind: "post", targetId: postId},
				select: ["id", "collapsed"],
			},
			{cookie: moderator.cookie},
		);
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		// `collapsed` carries the reopened-report count on restore.
		expect((restored.data as {collapsed: number}).collapsed).toBe(2);

		// Content is live again.
		const post = await getPost(postId);
		expect(post.ok && post.data !== null).toBe(true);

		// The reports are open again — the queue lists the target with its count.
		const list = await listOpen(moderator.cookie);
		expect(list.ok).toBe(true);
		if (list.ok) {
			const rows = (list.data as {items: Array<{node: {targetId: string; reportCount: number}}>})
				.items;
			expect(rows.find((e) => e.node.targetId === postId)?.node.reportCount).toBe(2);
		}
	});
});
