/**
 * Account deletion = anonymize-to-`@[silinen]` (ADR 0097) — black-box against the
 * deployed worker `/fate` route on real remote D1 (ADR 0082 integration tier).
 *
 * Proves the end-to-end anonymize semantics a substituted seam can't reach:
 *   - **Content stays Live, re-attributed to `silinen`.** A deleted user's
 *     definition still lists on its term page after deletion (NOT removed); the
 *     `@[silinen]` profile's counters absorb the re-attributed content.
 *   - **Karma is KEPT.** The up-vote that scored the content is not reversed — the
 *     content keeps its score after the author's account is anonymized.
 *   - **Identity rows are gone.** The author's session no longer authenticates: a
 *     `me` read with the pre-deletion cookie returns `UNAUTHORIZED`.
 *   - **The typed confirmation gates the op.** A wrong/absent confirmation never
 *     deletes (the input fails validation); only the exact phrase fires it.
 *
 * Everything is observed over HTTP; every email/slug/username is `del-${STAMP}-…`
 * prefixed for this file's isolated stage.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now().toString(36);
let counter = 0;
const uname = (label: string) => `del-${STAMP}-${label}-${counter++}`;

const CONFIRMATION = "hesabımı kalıcı olarak sil";

interface DefNode {
	id: string;
	score: number;
	author: string;
	authorId: string;
}
type Connection<N> = {items: Array<{cursor: string; node: N}>};
const definitions = (data: unknown): DefNode[] =>
	(data as {definitions: Connection<DefNode>}).definitions.items.map((e) => e.node);

async function setUsername(cookie: string, value: string): Promise<void> {
	const r = await h.fate(
		{kind: "mutation", name: "user.setUsername", input: {value}, select: ["id"]},
		{cookie},
	);
	expect(r.ok).toBe(true);
}

beforeAll(() => {
	expect(typeof h.url()).toBe("string");
});

describe("account.delete — anonymize-to-@[silinen]", () => {
	it("re-attributes content to @[silinen] (kept Live, karma kept) and tears down the session", async () => {
		const authorUsername = uname("author");
		const author = await h.signUp(`del-${STAMP}-author@test.local`, "hunter2hunter2", "Author");
		await setUsername(author.cookie, authorUsername);

		// The author writes a definition; a distinct voter up-votes it (author karma → 1).
		const termSlug = `del-${STAMP}-term`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug, termTitle: "Deletion Term", body: "content that survives its author"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const definitionId = (added.data as {id: string}).id;

		const voter = await h.signUp(`del-${STAMP}-voter@test.local`, "hunter2hunter2", "Voter");
		const vote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		if (!vote.ok) return;
		expect((vote.data as {score: number}).score).toBe(1);

		// A wrong confirmation never deletes (input validation rejects it).
		const wrong = await h.fate(
			{kind: "mutation", name: "account.delete", input: {confirmation: "sil"}, select: ["deleted"]},
			{cookie: author.cookie, retry: true},
		);
		expect(wrong.ok).toBe(false);
		// The session is still alive after the rejected attempt — nothing was torn down.
		const stillMe = await h.fate(
			{kind: "query", name: "me", select: ["id"]},
			{cookie: author.cookie},
		);
		expect(stillMe.ok).toBe(true);

		// The exact phrase fires the anonymization.
		const del = await h.fate(
			{
				kind: "mutation",
				name: "account.delete",
				input: {confirmation: CONFIRMATION},
				select: ["deleted"],
			},
			{cookie: author.cookie, retry: true},
		);
		expect(del.ok).toBe(true);
		if (del.ok) expect((del.data as {deleted: boolean}).deleted).toBe(true);

		// Identity torn down: the author's pre-deletion session no longer authenticates.
		const goneMe = await h.fate(
			{kind: "query", name: "me", select: ["id"]},
			{cookie: author.cookie},
		);
		expect(goneMe.ok).toBe(false);
		if (!goneMe.ok) expect(goneMe.error.code).toBe("UNAUTHORIZED");

		// The definition stays LIVE on its term page (re-attribution, NOT removal),
		// now authored by @[silinen], with its score INTACT (votes/karma kept — the
		// up-vote that scored it is not reversed by the author's deletion).
		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id", "definitions.score", "definitions.author", "definitions.authorId"],
		});
		expect(term.ok).toBe(true);
		if (term.ok) {
			const def = definitions(term.data).find((d) => d.id === definitionId);
			expect(def).toBeDefined();
			if (def) {
				expect(def.authorId).toBe("silinen");
				expect(def.author).toBe("@[silinen]");
				expect(def.score).toBe(1);
			}
		}

		// The sentinel profile's live definition counter absorbed the re-attributed
		// content (it now authors at least this one definition).
		const silinenAfter = await h.fate({
			kind: "query",
			name: "profile",
			args: {username: "silinen"},
			select: ["username", "displayName", "definitionCount"],
		});
		expect(silinenAfter.ok).toBe(true);
		if (silinenAfter.ok) {
			const p = silinenAfter.data as {
				username: string;
				displayName: string | null;
				definitionCount: number;
			};
			expect(p.username).toBe("silinen");
			expect(p.displayName).toBe("@[silinen]");
			expect(p.definitionCount).toBeGreaterThanOrEqual(1);
		}
	});

	it("the @[silinen] sentinel is seeded and resolvable as a real profile", async () => {
		const res = await h.fate({
			kind: "query",
			name: "profile",
			args: {username: "silinen"},
			select: ["username", "displayName"],
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			const p = res.data as {username: string; displayName: string | null};
			expect(p.username).toBe("silinen");
			expect(p.displayName).toBe("@[silinen]");
		}
	});

	it("nobody can register the reserved `silinen` username", async () => {
		const squatter = await h.signUp(`del-${STAMP}-squat@test.local`, "hunter2hunter2", "Squatter");
		const r = await h.fate(
			{kind: "mutation", name: "user.setUsername", input: {value: "silinen"}, select: ["id"]},
			{cookie: squatter.cookie},
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("INVALID_FORMAT");
	});
});
