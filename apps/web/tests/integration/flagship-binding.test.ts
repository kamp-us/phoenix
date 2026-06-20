/**
 * Flagship binding — system-tier proof (epic #488, child #507).
 *
 * The integration harness deploys the real alchemy stack (with the `FlagshipApp`
 * resource declared and `bind()`-resolved in the worker init) to a local workerd
 * and asserts black-box over HTTP. `/api/health` drives one boolean evaluation
 * through the resolved `FlagshipClient`; the read completing at all proves the
 * binding resolved end-to-end through the worker, so the probe reports
 * `flagshipReachable: true` — the system-tier check #507 calls for. The field
 * asserts reachability of the binding, not the value of any feature flag.
 */
import {describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

describe("Flagship binding — /api/health", () => {
	it("reports flagshipReachable once the FlagshipClient binding resolves end-to-end", async () => {
		const res = await h.req("/api/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {status: string; flagshipReachable: boolean};
		expect(body.status).toBe("ok");
		// an evaluation returned through the binding ⇒ the client resolved end-to-end
		expect(body.flagshipReachable).toBe(true);
	});
});
