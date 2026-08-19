/**
 * Throwaway sanity test for the run-scoped SHARED stage (ADR 0104 step 7, #1027): it proves the
 * deploy-once + inject substrate works in CI and migrates nothing. Delete it (or fold it into a
 * real migrated file) once the migration lands.
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
