/**
 * Ban session-refusal enforcement — black-box against the deployed worker over real remote D1
 * (ADR 0082 integration tier), the security core of #970. The load-bearing AC: a ban refuses the
 * banned user's EXISTING session at the auth boundary, because `Pasaport.validateSession` reads
 * ban-state fresh from D1 per request.
 *
 * The ban rows are written DIRECTLY to D1, not through the `user.banUser` mutation: that write
 * path is dark behind the default-off `phoenix-user-ban` flag (ADR 0083), so this drives the
 * enforcement read the way a released ban would. The mutation authority is the `unit` tier
 * (`worker/features/pasaport/ban-mutation.unit.test.ts`), as is the projection (`ban.unit.test.ts`).
 *
 * Runs on the run-scoped SHARED stage (ADR 0104), `NS`-prefixed so its rows are its own.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {makeIntegrationD1Rest} from "./_cf-rest-transport.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

let d1: D1Database;

// Epoch SECONDS — the encoding drizzle's `integer(..., {mode: "timestamp"})` stores,
// so a directly-inserted row decodes back to the same `Date` the worker's ban-state
// read (`resolveBanState`) projects over. A millis insert would decode to a Date far
// in the future and never expire.
const nowSec = () => Math.floor(Date.now() / 1000);

// D1 REST params is a strict `string[]` that REJECTS a null element (packages/d1-rest
// `assertRestParam`, #569): a SQL NULL must be rendered inline by OMITTING the nullable
// column from the INSERT, never bound as a null param. `reason`/`expires_at` are the two
// nullable columns (migration 0024) — include each only when its value is non-null so an
// omitted column defaults to SQL NULL; the always-present columns bind unconditionally.
const insertBanEvent = (row: {
	userId: string;
	action: "ban" | "unban";
	actorId: string;
	reason: string | null;
	expiresAtSec: number | null;
	createdAtSec: number;
}) => {
	const cols = ["id", "user_id", "action", "actor_id", "created_at"];
	const values: (string | number)[] = [
		crypto.randomUUID(),
		row.userId,
		row.action,
		row.actorId,
		row.createdAtSec,
	];
	if (row.reason !== null) {
		cols.push("reason");
		values.push(row.reason);
	}
	if (row.expiresAtSec !== null) {
		cols.push("expires_at");
		values.push(row.expiresAtSec);
	}
	const placeholders = cols.map(() => "?").join(", ");
	return d1
		.prepare(`INSERT INTO user_ban_event (${cols.join(", ")}) VALUES (${placeholders})`)
		.bind(...values)
		.run();
};

// D1 read-replica lag means a just-landed ban row can take a beat to reach the worker's read,
// so poll to the expected outcome under a bounded budget rather than assert once and flake.
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
	d1 = makeIntegrationD1Rest({accountId, databaseId});
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

		expect(await meIsHonored(user.cookie)).toBe(true);

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

		await insertBanEvent({
			userId: user.userId,
			action: "ban",
			actorId: `${NS}-admin`,
			reason: "temporary",
			expiresAtSec: nowSec() - 3600,
			createdAtSec: nowSec(),
		});
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
