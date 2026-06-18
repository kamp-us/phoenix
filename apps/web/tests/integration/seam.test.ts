/**
 * fate seam — black-box against the deployed worker `/fate` route (ADR 0026–0031).
 *
 * Ported from the pre-alchemy `fate-seam.test.ts`, which drove `SELF.fetch` inside
 * workerd and asserted against `env.PHOENIX_DB`. The new harness deploys the real
 * stack to a local workerd and asserts purely over HTTP. Only the observable seam
 * survives:
 *   - `health` resolves data produced by a real Effect service method
 *     (`Stats.getLandingStats` reading D1) — `definitions` is a number, not a stub.
 *   - `me` resolved anonymously fails the `Auth.required` gate and serializes as
 *     `{ok:false, error:{code:"UNAUTHORIZED"}}` — the wire code the SPA keys off.
 */
import {describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

describe("fate seam — /fate", () => {
	it("health resolves data produced by an Effect service method", async () => {
		const result = await h.fate({
			kind: "query",
			name: "health",
			select: ["status", "definitions"],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {status: string; definitions: number};
		expect(data.status).toBe("ok");
		// `definitions` comes from Stats.getLandingStats() reading definition_view —
		// a number, not a stub/undefined.
		// not portable black-box: the exact count is a shared-D1 aggregate (other
		// test files seed definitions), so we assert the type, not a D1 row read-back.
		expect(typeof data.definitions).toBe("number");
		expect(data.definitions).toBeGreaterThanOrEqual(0);
	});

	it("a tagged domain error serializes as {ok:false, error:{code}} — Unauthorized → UNAUTHORIZED", async () => {
		// `me` is anonymous here (no session cookie) → CurrentUser.required fails
		// with the `Unauthorized` tagged error → encodeWireError → UNAUTHORIZED.
		const result = await h.fate({
			kind: "query",
			name: "me",
			select: ["id"],
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});
