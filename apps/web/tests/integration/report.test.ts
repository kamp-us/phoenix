/**
 * report.submit DEPTH — black-box against the deployed worker `/fate` route
 * (ADR 0026–0031), the real-D1 integration coverage #610 / ADR 0082 call for.
 *
 * The report engine's irreducible real-D1 facts — composite-PK idempotency
 * (`(reporter_id, target_kind, target_id)` + `onConflictDoNothing` ⇒
 * `meta.changes === 0` ⇒ `created === false` on a re-report) and `deletedAt IS
 * NULL` soft-delete rejection — are only otherwise asserted through a `node:sqlite`
 * mock (#581); this suite exercises them over real D1, mirroring
 * `pano-comments.test.ts`'s vote-idempotency shape.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one
 * D1 is shared across every migrated file: every title/email/target id it seeds is
 * prefixed with `NS` (this file's deterministic `nsToken`) so its rows are uniquely
 * its own and every assertion scopes to them.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

interface Receipt {
	__typename: string;
	id: string;
	targetKind: string;
	targetId: string;
	created: boolean;
}

let reporter: {userId: string; cookie: string};
let author: {userId: string; cookie: string};
let postId = "";
let commentId = "";
let definitionId = "";

async function submitReport(
	input: {targetKind: string; targetId: string; reason?: string},
	cookie?: string,
) {
	return h.fate(
		{
			kind: "mutation",
			name: "report.submit",
			input,
			select: ["id", "targetKind", "targetId", "created"],
		},
		cookie ? {cookie} : undefined,
	);
}

beforeAll(async () => {
	reporter = await h.signUp(`${NS}-reporter@test.local`, "hunter2hunter2", "muhbir");
	author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "anka");

	const post = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title: `${NS} target post`, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(post.ok).toBe(true);
	if (!post.ok) throw new Error("seed post failed");
	postId = (post.data as {id: string}).id;

	const comment = await h.fate(
		{
			kind: "mutation",
			name: "comment.add",
			input: {postId, body: "report target comment — long enough"},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(comment.ok).toBe(true);
	if (!comment.ok) throw new Error("seed comment failed");
	commentId = (comment.data as {id: string}).id;

	const seeded = await h.seedTerm({
		slug: `${NS}-term`,
		title: `${NS} term`,
		definitions: [{authorName: "anka", body: "report target definition body"}],
	});
	definitionId = seeded.definitions[0]!.id;
});

describe("report.submit — persistence + idempotency (real D1)", () => {
	it("an authed report on a live post persists and acks created=true", async () => {
		const r = await submitReport(
			{targetKind: "post", targetId: postId, reason: "spam"},
			reporter.cookie,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const receipt = r.data as Receipt;
		expect(receipt.__typename).toBe("ReportReceipt");
		expect(receipt.id).toBe(`post:${postId}`);
		expect(receipt.targetKind).toBe("post");
		expect(receipt.targetId).toBe(postId);
		expect(receipt.created).toBe(true);
	});

	it("a re-report of the same target by the same reporter is an idempotent no-op (created=false)", async () => {
		const first = await submitReport({targetKind: "comment", targetId: commentId}, reporter.cookie);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as Receipt).created).toBe(true);

		const second = await submitReport(
			{targetKind: "comment", targetId: commentId},
			reporter.cookie,
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as Receipt).created).toBe(false);
	});

	it("a definition report persists and acks created=true", async () => {
		const r = await submitReport(
			{targetKind: "definition", targetId: definitionId},
			reporter.cookie,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.data as Receipt).created).toBe(true);
		expect((r.data as Receipt).id).toBe(`definition:${definitionId}`);
	});
});

describe("report.submit — auth + target gating (real D1)", () => {
	it("an anonymous report fails UNAUTHORIZED", async () => {
		const r = await submitReport({targetKind: "post", targetId: postId});
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("UNAUTHORIZED");
	});

	it("a report against a non-existent post target → POST_NOT_FOUND (feature-level, not infra)", async () => {
		const r = await submitReport(
			{targetKind: "post", targetId: `post_${NS}_does_not_exist`},
			reporter.cookie,
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("POST_NOT_FOUND");
	});

	it("a report against a non-existent comment target → COMMENT_NOT_FOUND", async () => {
		const r = await submitReport(
			{targetKind: "comment", targetId: `comm_${NS}_does_not_exist`},
			reporter.cookie,
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("COMMENT_NOT_FOUND");
	});

	it("a report against a non-existent definition target → DEFINITION_NOT_FOUND", async () => {
		const r = await submitReport(
			{targetKind: "definition", targetId: `def_${NS}_does_not_exist`},
			reporter.cookie,
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("DEFINITION_NOT_FOUND");
	});

	it("a report against a soft-deleted post → POST_NOT_FOUND (deletedAt IS NULL gate)", async () => {
		const post = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: `${NS} soft-deleted target`, tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(post.ok).toBe(true);
		if (!post.ok) return;
		const deletedPostId = (post.data as {id: string}).id;

		const del = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: deletedPostId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		const r = await submitReport({targetKind: "post", targetId: deletedPostId}, reporter.cookie);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.code).toBe("POST_NOT_FOUND");
	});
});
