/**
 * fate seam — end-to-end proof of Task 1.
 *
 * Drives the real worker `/fate` route inside workerd via `SELF.fetch`, so the
 * whole seam runs: Hono route → session validation → per-request
 * `ManagedRuntime` (built after validation, disposed via
 * `executionCtx.waitUntil`) → fate `handleRequest` → `fateQuery` → an Effect
 * service method → wire response.
 *
 * Asserts observable behavior only (resolved data, wire error code), never
 * fate or runtime internals:
 *   - `health` returns data produced by `Stats.getLandingStats` (a real
 *     service method reading D1), not a stub.
 *   - `me` resolved anonymously fails the `Auth.required` gate and serializes
 *     as `{ok: false, error: {code: "UNAUTHORIZED"}}` — the same wire code the
 *     GraphQL path produced.
 *   - the still-running `/graphql` endpoint is untouched.
 */
import {env, SELF} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const statements = baselineMigration
		.split("--> statement-breakpoint")
		.map((s: string) => s.trim())
		.filter(Boolean);
	for (const stmt of statements) {
		try {
			await env.PHOENIX_DB.prepare(stmt).run();
		} catch (err) {
			const msg = String(err);
			if (
				!msg.includes("already exists") &&
				!msg.includes("duplicate column") &&
				!msg.includes("no such table") &&
				!msg.includes("no such index")
			) {
				throw err;
			}
		}
	}
}

/** POST one fate operation and return its single result. */
async function fateOp(operation: Record<string, unknown>) {
	const res = await SELF.fetch("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [operation]}),
	});
	const body = (await res.json()) as {
		version: number;
		results: Array<
			| {ok: true; data: unknown; id: string}
			| {ok: false; error: {code: string; message?: string}; id: string}
		>;
	};
	return {status: res.status, result: body.results[0]};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("fate seam — /fate", () => {
	it("health resolves data produced by an Effect service method", async () => {
		const {result} = await fateOp({
			kind: "query",
			name: "health",
			id: "1",
			select: ["status", "definitions"],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			const data = result.data as {status: string; definitions: number};
			expect(data.status).toBe("ok");
			// `definitions` comes from Stats.getLandingStats() reading
			// definition_view — a number, not a stub/undefined.
			expect(typeof data.definitions).toBe("number");

			const row = await env.PHOENIX_DB.prepare(
				"SELECT COUNT(*) as n FROM definition_view WHERE deleted_at IS NULL",
			).first<{n: number}>();
			expect(data.definitions).toBe(row?.n ?? 0);
		}
	});

	it("a tagged domain error serializes as {ok:false, error:{code}} — Unauthorized → UNAUTHORIZED", async () => {
		// `me` is anonymous here (no session cookie) → Auth.required fails with
		// the `Unauthorized` tagged error → encodeFateError → UNAUTHORIZED.
		const {result} = await fateOp({
			kind: "query",
			name: "me",
			id: "1",
			select: ["id"],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("UNAUTHORIZED");
		}
	});

	it("/graphql still works unchanged", async () => {
		const res = await SELF.fetch("https://test.local/graphql", {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({query: "{ __typename }"}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {data?: {__typename: string}};
		expect(body.data?.__typename).toBe("Query");
	});
});
