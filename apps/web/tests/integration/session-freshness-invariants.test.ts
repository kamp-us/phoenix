/**
 * Session freshness is a TWO-AXIS invariant (ADR 0169) — black-box against the
 * deployed worker on real remote D1 (ADR 0082 integration tier).
 *
 * ADR 0169 rejects session caching because a session-perf/caching review is a
 * two-axis check, and the first #2263 `cookieCache` review scoped only axis (1) and
 * missed axis (2) — the account-deletion integration test caught the teardown hole by
 * luck, not by the review. This file encodes BOTH axes as REQUIRED, deterministic
 * invariants so the catch lives in the suite, not in one incident:
 *
 *   1. **Capability staleness.** A gated decision (role/tier/karma/ban/kefil) must read
 *      the capability FRESH from Künye on every request — never from a snapshot minted
 *      into the session at login. Proven on the "earn to vote" tier gate (#1810): a
 *      çaylak's cast is rejected, and an out-of-band promotion (no re-login, the SAME
 *      cookie) is honored on the very next cast. A session-cache of the tier would keep
 *      serving the stale çaylak snapshot and fail this. (Its `kunye-admin-seam` /
 *      `kunye-moderate-seam` siblings prove the same fresh-per-call property for the
 *      admin/moderator relation tuples.)
 *   2. **Identity-continuity teardown.** A deleted / logged-out / revoked session must
 *      stop authenticating IMMEDIATELY, never after a TTL. The DELETE path is the
 *      `account-deletion.test` exemplar ADR 0169 keeps as-is; this file covers the
 *      LOGOUT/REVOKE path — sign-out tears the session down so the very next request
 *      under the same cookie is `UNAUTHORIZED`. A `cookieCache` window would keep the
 *      torn-down identity alive for ≤TTL and fail this.
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
	// Axis 1: capability staleness. The tier that gates a vote is read fresh from Künye
	// on EVERY cast, so a capability change AFTER the cookie was minted is honored under
	// the SAME cookie — a login-time snapshot would keep the çaylak rejection.
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

		// çaylak cast is rejected by the live "earn to vote" tier gate (#1810).
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

	// Axis 2 (logout/revoke): sign-out tears the session down at once. The DELETE path of
	// this axis is `account-deletion.test`'s exemplar (ADR 0169 keeps it as-is); this is
	// its logout/revoke sibling — the same immediate-teardown invariant, different trigger.
	it("axis 2 — sign-out tears down the session immediately; the very next request is UNAUTHORIZED", async () => {
		const user = await h.signUp(`${NS}-logout@test.local`, "hunter2hunter2", "Logout");
		await setUsername(user.cookie, uname("logout"));

		// The session authenticates before logout.
		const before = await me(user.cookie);
		expect(before.ok).toBe(true);

		// Log out through the real better-auth endpoint — this revokes the session row.
		const out = await h.json("/api/auth/sign-out", {}, user.cookie);
		expect(out.ok).toBe(true);

		// The SAME cookie no longer authenticates — teardown is immediate, not eventual.
		// (A `cookieCache` TTL window would keep this torn-down identity alive for ≤TTL and
		// return `ok` here — the exact identity-continuity hole ADR 0169 rejects.)
		const after = await me(user.cookie);
		expect(after.ok).toBe(false);
		if (!after.ok) expect(after.error.code).toBe("UNAUTHORIZED");
	});

	// Axis 2 (delete): the invariant stated in its dedicated home, not as a side effect of
	// the anonymize-semantics test — the "caught by luck" gap ADR 0169 closes. The rich
	// re-attribution semantics stay owned by `account-deletion.test` (unrelaxed).
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
