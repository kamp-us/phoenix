/**
 * Throwaway sanity test for the run-scoped SHARED stage (ADR 0104 step 7, #1027, PR A).
 *
 * Proves the deploy-once + provide/inject substrate works end-to-end in CI: `_global-setup.ts`
 * deploys ONE stage in vitest `globalSetup`, this file builds the black-box harness over the
 * injected handle via `sharedStack()` (no per-file deploy), and asserts the injected worker
 * URL is a real workers.dev host serving healthy JSON. It migrates nothing — it is the ONLY
 * file on the shared stage in this PR; later PRs move the irreducible real-D1/DO files onto it.
 * Delete (or fold into a real migrated file) once the migration lands.
 */
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";

const h = sharedStack();

describe("shared-stage substrate", () => {
	it("injects a workers.dev url for the run-scoped shared stage", () => {
		expect(h.url()).toMatch(/workers\.dev/);
	});

	it("serves healthy JSON from the shared stage's worker", async () => {
		const res = await h.req("/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status?: string};
		expect(body.status).toBe("ok");
	});
});
