/**
 * Session freshness is a TWO-AXIS invariant (ADR 0169) — black-box against the
 * deployed worker on real remote D1 (ADR 0082 integration tier).
 *
 * The two axes — capability staleness (#1810, #2263) and identity-continuity teardown —
 * are encoded here as REQUIRED, deterministic invariants so the catch lives in the suite,
 * not in one incident. See ADR 0169.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7). Every email/username is `NS`-
 * prefixed (this file's deterministic token) so its rows can't collide with a
 * concurrent file's on the shared D1. The confirmation phrase is a product constant.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
let counter = 0;
const uname = (label: string) => `${NS}-${label}-${counter++}`;

const CONFIRMATION = "hesabımı kalıcı olarak sil";

async function setUsername(cookie: string, value: string): Promise<void> {
	const r = await h.fate(
		{kind: "mutation", name: "user.setUsername", input: {value}, select: ["id"]},
		{cookie},
	);
	expect(r.ok).toBe(true);
}

async function me(cookie: string) {
	return h.fate({kind: "query", name: "me", select: ["id"]}, {cookie});
}

beforeAll(() => {
	expect(typeof h.url()).toBe("string");
});

describe("ADR 0169 — session freshness is a two-axis invariant", () => {
	it("axis 1 — a capability change (çaylak→yazar) is read FRESH under the same session, not from a login snapshot", async () => {
		// An eligible author owns a definition the subject can vote on (a self-vote is a
		// distinct rejection — `SELF_VOTE_NOT_ALLOWED` — so the target must be someone else's).
		const author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "Author");
		await setUsername(author.cookie, uname("author"));
		await h.promoteToYazar(author.userId);
		const termSlug = `${NS}-cap-term`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {
					termSlug,
					termTitle: "Capability Term",
					body: "a definition the subject can vote on",
				},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const definitionId = (added.data as {id: string}).id;

		// The subject signs up as a çaylak — THIS cookie is the "session snapshot" moment.
		const subject = await h.signUp(`${NS}-subject@test.local`, "hunter2hunter2", "Subject");
		await setUsername(subject.cookie, uname("subject"));

		const beforePromote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: subject.cookie},
		);
		expect(beforePromote.ok).toBe(false);
		if (!beforePromote.ok) expect(beforePromote.error.code).toBe("VOTE_REQUIRES_YAZAR");

		// Promote out-of-band: the tier column flips WITHOUT a re-login, so the subject's
		// cookie is byte-for-byte the same one minted while it was a çaylak.
		await h.promoteToYazar(subject.userId);

		// The very next cast under that SAME cookie is honored — the gate read the FRESH
		// tier from Künye, never a login-time snapshot. (A session-cache of the capability
		// would keep serving çaylak here and this assertion would fail — the axis-1 guard.)
		const afterPromote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: subject.cookie, retry: true},
		);
		expect(afterPromote.ok).toBe(true);
		if (afterPromote.ok) expect((afterPromote.data as {score: number}).score).toBe(1);
	});

	it("axis 2 — sign-out tears down the session immediately; the very next request is UNAUTHORIZED", async () => {
		const user = await h.signUp(`${NS}-logout@test.local`, "hunter2hunter2", "Logout");
		await setUsername(user.cookie, uname("logout"));

		const before = await me(user.cookie);
		expect(before.ok).toBe(true);

		const out = await h.json("/api/auth/sign-out", {}, user.cookie);
		expect(out.ok).toBe(true);

		// The SAME cookie no longer authenticates — teardown is immediate, not eventual.
		// (A `cookieCache` TTL window would keep this torn-down identity alive for ≤TTL and
		// return `ok` here — the exact identity-continuity hole ADR 0169 rejects.)
		const after = await me(user.cookie);
		expect(after.ok).toBe(false);
		if (!after.ok) expect(after.error.code).toBe("UNAUTHORIZED");
	});

	// The rich re-attribution semantics stay owned by `account-deletion.test`; this pins only
	// the teardown, in its own home rather than as a side effect of that test.
	it("axis 2 — account deletion tears down the session immediately; the very next request is UNAUTHORIZED", async () => {
		const user = await h.signUp(`${NS}-delete@test.local`, "hunter2hunter2", "Delete");
		await setUsername(user.cookie, uname("delete"));

		const before = await me(user.cookie);
		expect(before.ok).toBe(true);

		const del = await h.fate(
			{
				kind: "mutation",
				name: "account.delete",
				input: {confirmation: CONFIRMATION},
				select: ["deleted"],
			},
			{cookie: user.cookie, retry: true},
		);
		expect(del.ok).toBe(true);
		if (del.ok) expect((del.data as {deleted: boolean}).deleted).toBe(true);

		const after = await me(user.cookie);
		expect(after.ok).toBe(false);
		if (!after.ok) expect(after.error.code).toBe("UNAUTHORIZED");
	});
});
