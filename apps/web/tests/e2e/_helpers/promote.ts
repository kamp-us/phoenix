/**
 * Privileged e2e setup: promote a signed-up user to the `yazar` authorship tier
 * over the Cloudflare D1 REST API (ADR 0137).
 *
 * The e2e harness is otherwise HTTP-only against the deployed per-PR preview
 * worker — it has no privileged handle to set account state the public seam
 * guards (`user.tier` is `input:false` to better-auth, server-promoted only;
 * `worker/db/drizzle/schema.ts`). Some flows need a `yazar`-tier actor to run at
 * all: the anti-manipulation vote-gate (#1828/#1810) rejects a çaylak newcomer's
 * pano post-vote, so a two-client live spec whose voter is a fresh signup can no
 * longer cast that vote through the UI.
 *
 * This mirrors the integration harness's setup-only D1 REST path exactly
 * (`tests/integration/_harness.ts`: `cloudflareApi` + `runD1Query`): an
 * authenticated `POST /accounts/{accountId}/d1/database/{databaseId}/query` with
 * `Bearer $CLOUDFLARE_API_TOKEN`, run against the preview stage's D1. The account
 * + database id come from the environment the e2e CI job injects
 * (`.github/workflows/ci.yml` `e2e` job): `CLOUDFLARE_ACCOUNT_ID` from the secret,
 * and `E2E_D1_DATABASE_ID` — the preview D1 uuid deploy.yml surfaces in the sticky
 * `<!-- d1:<uuid> -->` token the job already reads for the seed step.
 *
 * Setup-only, never on a black-box assertion path. It is the ONE privileged handle
 * the deployed-preview e2e harness has; it is NOT a runtime route on the public
 * worker (the deleted fail-open `/api/admin/*` seeder is the rejected alternative,
 * ADR 0137 / CLAUDE.md "Sözlük seed").
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** The CF REST coordinates + bearer the e2e CI job injects (ADR 0137). */
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

/**
 * One authenticated D1 REST query against the preview stage's D1. Throws on a
 * non-2xx or a D1-reported SQL error (so a botched setup fails the spec loudly),
 * and returns D1's affected-row count. Mirrors the integration harness's
 * `runD1Query` (`tests/integration/_harness.ts`).
 */
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
 * Promote the user with the given sign-up `email` to the `yazar` tier by a
 * direct D1 `UPDATE` off the worker binding — the privileged state the public
 * seam refuses to set. Keyed by `email` because the e2e UI sign-up flow does not
 * surface the assigned user id; `email` is unique per better-auth signup and the
 * only stable handle a spec holds. Throws if no row matched (a mistyped email or a
 * signup that never landed), so a silent no-promote can't leave the gate red for
 * the wrong reason.
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
