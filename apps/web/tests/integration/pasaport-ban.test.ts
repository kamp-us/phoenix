/**
 * Ban session-refusal enforcement — black-box against the deployed worker `/fate`
 * route over **real remote D1** (ADR 0026–0031 / ADR 0082 integration tier), the
 * security core of #970 (admin epic #968).
 *
 * The load-bearing AC (#970): a ban actually **refuses the banned user's existing
 * session at the auth boundary** — not a cosmetic flag. So the round-trip is asserted
 * end to end: sign up → `me` resolves (access) → append a `ban` event → `me` is
 * REFUSED as if signed-out (`UNAUTHORIZED`) even with the SAME valid cookie → append
 * an `unban` event → `me` resolves again (access restored). The enforcement lives in
 * `Pasaport.validateSession`, which reads the ban-state FRESH from D1 per request, so
 * an EXISTING session flips the moment the ban row lands — the whole point.
 *
 * The ban rows are written DIRECTLY to D1 here (not through the flag-gated
 * `user.banUser` mutation): the write path is dark behind `phoenix-user-ban`
 * (default-off, ADR 0083), so this test drives the enforcement read the way a
 * released ban would, and simultaneously asserts the audit row the enforcement reads
 * carries the actor/target/reason/expiry/time (AC #970). The mutation authority
 * (fail-closed for a non-admin) is the `unit` tier
 * (`worker/features/pasaport/ban-mutation.unit.test.ts`); the projection is
 * `worker/features/pasaport/ban.unit.test.ts`.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104); every id/email is `NS`-prefixed
 * (this file's deterministic token) so its rows are its own, and each user's ban
 * events are cleaned up after the suite.
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {makeD1Rest} from "@kampus/d1-rest";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);
const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

let d1: D1Database;

// Epoch SECONDS — the encoding drizzle's `integer(..., {mode: "timestamp"})` stores,
// so a directly-inserted row decodes back to the same `Date` the worker's ban-state
// read (`resolveBanState`) projects over. A millis insert would decode to a Date far
// in the future and never expire.
const nowSec = () => Math.floor(Date.now() / 1000);

const insertBanEvent = (row: {
	userId: string;
	action: "ban" | "unban";
	actorId: string;
	reason: string | null;
	expiresAtSec: number | null;
	createdAtSec: number;
}) =>
	d1
		.prepare(
			"INSERT INTO user_ban_event (id, user_id, action, actor_id, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			crypto.randomUUID(),
			row.userId,
			row.action,
			row.actorId,
			row.reason,
			row.expiresAtSec,
			row.createdAtSec,
		)
		.run();

// `me` under a cookie: is the session honored (resolves the User) or refused
// (UNAUTHORIZED, i.e. treated as anonymous)? D1 read-replica lag means a just-landed
// ban row can take a beat to be visible to the worker's read, so poll to the expected
// outcome under a bounded budget rather than assert once and flake.
const meIsHonored = async (cookie: string): Promise<boolean> => {
	const result = await h.fate({kind: "query", name: "me", select: ["id"]}, {cookie});
	return result.ok;
};

const waitForHonored = async (cookie: string, want: boolean): Promise<boolean> => {
	for (let i = 0; i < 20; i++) {
		if ((await meIsHonored(cookie)) === want) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return (await meIsHonored(cookie)) === want;
};

const userIds: string[] = [];

beforeAll(async () => {
	const {accountId, databaseId} = await h.d1Target();
	d1 = makeD1Rest({accountId, databaseId, layer: restLayer});
});

afterAll(async () => {
	if (userIds.length > 0) {
		await d1
			.prepare(`DELETE FROM user_ban_event WHERE user_id IN (${userIds.map(() => "?").join(",")})`)
			.bind(...userIds)
			.run();
	}
});

describe("ban enforcement — session refused at the auth boundary (real D1)", () => {
	it("ban refuses the EXISTING session; unban restores access — the full round-trip", async () => {
		const user = await h.signUp(`${NS}-roundtrip@test.local`, "hunter2hunter2", "Round Trip");
		userIds.push(user.userId);

		// Before any ban: the session is honored.
		expect(await meIsHonored(user.cookie)).toBe(true);

		// Ban → the SAME cookie's session is now refused (treated as anonymous).
		const banAt = nowSec();
		await insertBanEvent({
			userId: user.userId,
			action: "ban",
			actorId: `${NS}-admin`,
			reason: "spam",
			expiresAtSec: null,
			createdAtSec: banAt,
		});
		expect(await waitForHonored(user.cookie, false)).toBe(true);

		// Unban (a later event) → access restored on the next request, no re-login.
		await insertBanEvent({
			userId: user.userId,
			action: "unban",
			actorId: `${NS}-admin`,
			reason: null,
			expiresAtSec: null,
			createdAtSec: banAt + 5,
		});
		expect(await waitForHonored(user.cookie, true)).toBe(true);
	});

	it("an already-elapsed ban expiry self-lifts — the session stays honored", async () => {
		const user = await h.signUp(`${NS}-expired@test.local`, "hunter2hunter2", "Expired Ban");
		userIds.push(user.userId);

		// A ban whose `expires_at` is already in the past projects to not-banned.
		await insertBanEvent({
			userId: user.userId,
			action: "ban",
			actorId: `${NS}-admin`,
			reason: "temporary",
			expiresAtSec: nowSec() - 3600,
			createdAtSec: nowSec(),
		});
		// It never refuses — poll a few times to be sure it doesn't flip late.
		expect(await waitForHonored(user.cookie, true)).toBe(true);
	});

	it("every ban/unban event persists its audit fields (actor, target, reason, time)", async () => {
		const user = await h.signUp(`${NS}-audit@test.local`, "hunter2hunter2", "Audit Trail");
		userIds.push(user.userId);

		const at = nowSec();
		await insertBanEvent({
			userId: user.userId,
			action: "ban",
			actorId: `${NS}-admin`,
			reason: "abuse",
			expiresAtSec: at + 86400,
			createdAtSec: at,
		});

		const audit = await d1
			.prepare(
				"SELECT action, actor_id, reason, expires_at, created_at FROM user_ban_event WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
			)
			.bind(user.userId)
			.first<{
				action: string;
				actor_id: string;
				reason: string | null;
				expires_at: number | null;
				created_at: number;
			}>();

		expect(audit).not.toBeNull();
		expect(audit?.action).toBe("ban");
		expect(audit?.actor_id).toBe(`${NS}-admin`);
		expect(audit?.reason).toBe("abuse");
		expect(audit?.expires_at).toBe(at + 86400);
		expect(audit?.created_at).toBe(at);
	});
});
