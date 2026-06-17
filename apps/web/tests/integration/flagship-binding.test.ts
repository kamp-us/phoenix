/**
 * Flagship binding — system-tier proof (epic #488, child #507).
 *
 * The integration harness deploys the real alchemy stack (with the `FlagshipApp`
 * resource declared and `bind()`-resolved in the worker init) to a local workerd
 * and asserts black-box over HTTP. `/api/health` reads one boolean flag through
 * the resolved `FlagshipClient`; a value coming back at all proves the binding
 * resolved end-to-end through the worker — the system-tier check #507 calls for.
 * No flag is declared yet, so the read falls back to its `false` default.
 */
import {describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness();

describe("Flagship binding — /api/health", () => {
	it("reads a flag value through the resolved FlagshipClient binding", async () => {
		const res = await h.req("/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status: string; flagshipBound: boolean};
		expect(body.status).toBe("ok");
		// the binding resolved and an evaluation returned: undeclared flag → default
		expect(body.flagshipBound).toBe(false);
	});
});
