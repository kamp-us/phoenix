/**
 * Agent-credential enabler (ADR 0044 Decision 3, #108) — black-box against the deployed worker's
 * `/api/auth/*` + `/fate` routes on real remote D1 (ADR 0082 integration tier), proving the
 * end-to-end apiKey contract a substituted seam can't reach.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104), `NS`-prefixed so its rows can't collide.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

async function createApiKey(cookie: string, name: string): Promise<string> {
	const res = await h.req(
		"/api/auth/api-key/create",
		{
			method: "POST",
			headers: {"content-type": "application/json", origin: "http://localhost:3000", cookie},
			body: JSON.stringify({name}),
		},
		{timeoutMs: 30_000},
	);
	expect(res.ok).toBe(true);
	const body = (await res.json()) as {key?: string};
	expect(typeof body.key).toBe("string");
	return body.key!;
}

// Read the `me` query carrying ONLY the `x-api-key` header (no session cookie), so a
// pass proves the key alone authenticated the request.
async function meViaApiKey(key: string): Promise<{ok: boolean; id?: string; code?: string}> {
	const res = await h.req(
		"/fate",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				"x-api-key": key,
			},
			body: JSON.stringify({
				version: 1,
				operations: [{id: "1", kind: "query", name: "me", select: ["id"]}],
			}),
		},
		{timeoutMs: 30_000},
	);
	const parsed = (await res.json()) as {
		results: Array<{ok: true; data: {id: string}} | {ok: false; error: {code: string}}>;
	};
	const r = parsed.results[0]!;
	return r.ok ? {ok: true, id: r.data.id} : {ok: false, code: r.error.code};
}

beforeAll(() => {
	expect(typeof h.url()).toBe("string");
});

describe("pasaport apiKey — durable agent credentials", () => {
	it("a session mints a key that authenticates a later request as the same user", async () => {
		const owner = await h.signUp(`${NS}-agent-owner@test.local`, "hunter2hunter2", "Agent Owner");

		const key = await createApiKey(owner.cookie, `${NS}-agent-key`);

		const me = await meViaApiKey(key);
		expect(me.ok).toBe(true);
		expect(me.id).toBe(owner.userId);
	});

	it("rejects an unauthenticated create (no fail-open mint)", async () => {
		const res = await h.req(
			"/api/auth/api-key/create",
			{
				method: "POST",
				headers: {"content-type": "application/json", origin: "http://localhost:3000"},
				body: JSON.stringify({name: `${NS}-anon-key`}),
			},
			{timeoutMs: 30_000},
		);
		expect(res.ok).toBe(false);
		expect(res.status).toBe(401);
	});
});
