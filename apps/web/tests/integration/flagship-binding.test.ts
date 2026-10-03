/**
 * Flagship binding — system-tier proof (#507). The Flag schema-drift PUT-skip patch pin (#3049)
 * deploys nothing and lives in `patch-pin-alchemy-flagship-flag-reconcile.unit.test.ts`.
 *
 * `flagshipReachable` asserts the binding resolved, not the value of any feature flag.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7) with no namespace token: read-only against
 * a deploy-time binding, seeding no data and reading no per-test rows, so nothing can collide.
 */
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";

const h = sharedStack();

describe("Flagship binding — /api/health", () => {
	it("reports flagshipReachable once the FlagshipClient binding resolves end-to-end", async () => {
		const res = await h.req("/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status: string; flagshipReachable: boolean};
		expect(body.status).toBe("ok");
		expect(body.flagshipReachable).toBe(true);
	});
});
