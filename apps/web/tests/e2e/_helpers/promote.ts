/**
 * Privileged e2e setup: promote a signed-up user to the `yazar` authorship tier over the
 * Cloudflare D1 REST API (ADR 0137), mirroring the integration harness's setup-only D1 REST path
 * (`tests/integration/_harness.ts`).
 *
 * Setup-only, never on a black-box assertion path. It is the ONE privileged handle the
 * deployed-preview e2e harness has; it is NOT a runtime route on the public worker (the deleted
 * fail-open `/api/admin/*` seeder is the rejected alternative — ADR 0137 / CLAUDE.md "Sözlük seed").
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

function d1RestFromEnv(): {accountId: string; databaseId: string; token: string} {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const databaseId = process.env.E2E_D1_DATABASE_ID;
	if (!token || !accountId || !databaseId) {
		throw new Error(
			"promoteToYazar needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and " +
				"E2E_D1_DATABASE_ID (the preview D1 uuid) — one or more is unset. The e2e CI " +
				"job injects all three (.github/workflows/ci.yml); locally they come from a " +
				"wrangler/alchemy profile + the local preview D1 id.",
		);
	}
	return {accountId, databaseId, token};
}

async function runD1Query(sql: string, params: unknown[]): Promise<number> {
	const {accountId, databaseId, token} = d1RestFromEnv();
	const res = await fetch(
		`${CLOUDFLARE_API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`,
		{
			method: "POST",
			headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
			body: JSON.stringify({sql, params}),
		},
	);
	if (!res.ok) {
		throw new Error(`Cloudflare D1 REST query failed: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as {
		result?: Array<{meta?: {changes?: number}}>;
		errors?: Array<{message: string}>;
	};
	if (body.errors?.length) {
		throw new Error(`D1 query failed (${sql}): ${body.errors.map((e) => e.message).join("; ")}`);
	}
	return body.result?.[0]?.meta?.changes ?? 0;
}

/**
 * Keyed by `email` because the e2e UI sign-up flow does not surface the assigned user id; it is
 * unique per better-auth signup and the only stable handle a spec holds.
 */
export async function promoteToYazar(email: string): Promise<void> {
	const changes = await runD1Query(`UPDATE "user" SET tier = 'yazar' WHERE email = ?`, [email]);
	if (changes !== 1) {
		throw new Error(
			`promoteToYazar(${email}): expected exactly 1 user row updated, got ${changes} — ` +
				"the sign-up may not have landed, or the email does not match a user row.",
		);
	}
}
