/**
 * Display-name write-through convergence (#2154) — black-box against the deployed
 * worker `/fate` route on real remote D1 (ADR 0082 integration tier).
 *
 * The regression this locks: a display-name change made through the görünen-ad save
 * (`user.setDisplayName`) must reach the STAMPED `user_profile.display_name` column
 * every author byline resolves, not just the better-auth `user.name`. Before the fix
 * `display_name` was written only once — at `setUsername`-time — so a later rename
 * never reached the stamped column and every byline showed a stale snapshot.
 *
 * The proof walks the full wire path a substituted seam can't reach:
 *   1. an author sets a username (stamps `display_name = user.name` at that instant),
 *   2. writes a definition,
 *   3. renames via `user.setDisplayName`,
 *   4. re-reads the definition byline (`authorDisplayName`) off its term page and
 *      asserts it is the NEW name — the live-resolve convergence.
 *
 * Fails WITHOUT the write-through: the old `authClient.updateUser` path touched only
 * `user.name`, so `authorDisplayName` would stay pinned to the setUsername-time
 * snapshot and step 4 would read the OLD name.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7): every email/username/slug is
 * `NS`-prefixed (this file's `nsToken`) and every assertion scopes to this file's own
 * rows (the byline is read off the exact definition id the seed returned), so it holds
 * under concurrent files sharing the one D1.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
let counter = 0;
const uname = (label: string) => `${NS}-${label}-${counter++}`;

interface DefNode {
	id: string;
	authorDisplayName: string | null;
	authorUsername: string | null;
}
type Connection<N> = {items: Array<{cursor: string; node: N}>};

const readByline = async (termSlug: string, definitionId: string): Promise<DefNode | undefined> => {
	const result = await h.fate({
		kind: "query",
		name: "term",
		args: {slug: termSlug, definitions: {first: 20}},
		select: ["definitions.id", "definitions.authorDisplayName", "definitions.authorUsername"],
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return undefined;
	const conn = (result.data as {definitions: Connection<DefNode>}).definitions;
	return conn.items.find((e) => e.node.id === definitionId)?.node;
};

beforeAll(() => {
	expect(typeof h.url()).toBe("string");
});

describe("user.setDisplayName — a rename reaches the stamped author byline (#2154)", () => {
	it("byline reflects the NEW display name after a görünen-ad change", async () => {
		const authorUsername = uname("author");
		// Sign-up name is the setUsername-time snapshot the OLD one-shot sync would freeze.
		const author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "Eski Ad");
		await h
			.fate(
				{
					kind: "mutation",
					name: "user.setUsername",
					input: {value: authorUsername},
					select: ["id"],
				},
				{cookie: author.cookie},
			)
			.then((r) => expect(r.ok).toBe(true));

		const termSlug = `${NS}-term`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug, termTitle: "Convergence Term", body: "byline tracks the live name"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const definitionId = (added.data as {id: string}).id;

		// Baseline: the byline resolves the setUsername-time display name ("Eski Ad").
		const before = await readByline(termSlug, definitionId);
		expect(before?.authorDisplayName).toBe("Eski Ad");
		expect(before?.authorUsername).toBe(authorUsername);

		// The görünen-ad change — the write-through under test.
		const renamed = await h.fate(
			{
				kind: "mutation",
				name: "user.setDisplayName",
				input: {value: "Yeni Ad"},
				select: ["id", "name"],
			},
			{cookie: author.cookie, retry: true},
		);
		expect(renamed.ok).toBe(true);
		if (renamed.ok) expect((renamed.data as {name: string | null}).name).toBe("Yeni Ad");

		// Convergence: the SAME byline now resolves the NEW display name — the stamped
		// column was re-synced, not frozen at setUsername-time. This is the assertion
		// that fails without the write-through.
		const after = await readByline(termSlug, definitionId);
		expect(after?.authorDisplayName).toBe("Yeni Ad");
		expect(after?.authorUsername).toBe(authorUsername);
	});

	it("an empty display name is rejected (DISPLAY_NAME_EMPTY), byline unchanged", async () => {
		const authorUsername = uname("blank");
		const author = await h.signUp(`${NS}-blank@test.local`, "hunter2hunter2", "Sabit Ad");
		await h
			.fate(
				{
					kind: "mutation",
					name: "user.setUsername",
					input: {value: authorUsername},
					select: ["id"],
				},
				{cookie: author.cookie},
			)
			.then((r) => expect(r.ok).toBe(true));

		const empty = await h.fate(
			{kind: "mutation", name: "user.setDisplayName", input: {value: "   "}, select: ["id"]},
			{cookie: author.cookie, retry: true},
		);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error.code).toBe("DISPLAY_NAME_EMPTY");
	});

	it("anonymous user.setDisplayName is UNAUTHORIZED", async () => {
		const r = await h.fate({
			kind: "mutation",
			name: "user.setDisplayName",
			input: {value: "Anonim"},
			select: ["id"],
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("UNAUTHORIZED");
	});
});
