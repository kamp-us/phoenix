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

// The landed-probes for this test's two NON-idempotent setup mutations. A stalled round-trip
// (real remote worker + D1) leaves it unknown whether the write committed, and neither op
// tolerates a blind replay — `user.setUsername` rejects a re-set with ALREADY_SET,
// `definition.add` mints a new id per call — so each declares how to tell, and a landed write
// is adopted instead of hard-failing the whole test (#3942).
const usernameLanded = async (cookie: string, value: string) => {
	const me = await h.fate({kind: "query", name: "me", select: ["id", "username"]}, {cookie});
	if (!me.ok) return undefined;
	return (me.data as {username: string | null}).username === value ? me : undefined;
};

const definitionLanded = async (cookie: string, termSlug: string, body: string) => {
	const result = await h.fate(
		{
			kind: "query",
			name: "term",
			args: {slug: termSlug, definitions: {first: 20}},
			select: ["definitions.id", "definitions.body"],
		},
		{cookie},
	);
	if (!result.ok) return undefined;
	const conn = (result.data as {definitions: Connection<{id: string; body: string}>}).definitions;
	const hit = conn.items.find((e) => e.node.body === body);
	return hit ? {ok: true as const, data: {id: hit.node.id}, id: "landed"} : undefined;
};

beforeAll(() => {
	expect(typeof h.url()).toBe("string");
});

describe("user.setDisplayName — a rename reaches the stamped author byline (#2154)", () => {
	it("byline reflects the NEW display name after a görünen-ad change", async () => {
		const authorUsername = uname("author");
		// Sign-up name is the setUsername-time snapshot the OLD one-shot sync would freeze.
		const author = await h.signUpYazar(`${NS}-author@test.local`, "hunter2hunter2", "Eski Ad");
		await h
			.fate(
				{
					kind: "mutation",
					name: "user.setUsername",
					input: {value: authorUsername},
					select: ["id"],
				},
				{cookie: author.cookie, converge: () => usernameLanded(author.cookie, authorUsername)},
			)
			.then((r) => expect(r.ok).toBe(true));

		const termSlug = `${NS}-term`;
		const body = "byline tracks the live name";
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug, termTitle: "Convergence Term", body},
				select: ["id"],
			},
			{cookie: author.cookie, converge: () => definitionLanded(author.cookie, termSlug, body)},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const definitionId = (added.data as {id: string}).id;

		const before = await readByline(termSlug, definitionId);
		expect(before?.authorDisplayName).toBe("Eski Ad");
		expect(before?.authorUsername).toBe(authorUsername);

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

		const after = await readByline(termSlug, definitionId);
		expect(after?.authorDisplayName).toBe("Yeni Ad");
		expect(after?.authorUsername).toBe(authorUsername);
	});

	it("an empty display name is rejected (DISPLAY_NAME_EMPTY), byline unchanged", async () => {
		const authorUsername = uname("blank");
		const author = await h.signUpYazar(`${NS}-blank@test.local`, "hunter2hunter2", "Sabit Ad");
		await h
			.fate(
				{
					kind: "mutation",
					name: "user.setUsername",
					input: {value: authorUsername},
					select: ["id"],
				},
				{cookie: author.cookie, converge: () => usernameLanded(author.cookie, authorUsername)},
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
