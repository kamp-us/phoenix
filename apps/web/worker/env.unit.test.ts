/** Unit tests for `resolveStateMode` — the deploy-time state-store selector. */
import {describe, expect, it} from "vitest";
import {resolveStateMode} from "./env.ts";

describe("resolveStateMode", () => {
	it("a real deploy (no CI, no dev signal) uses the Cloudflare-hosted store", () => {
		expect(resolveStateMode({})).toBe("cloudflare");
	});

	it("a real deploy on CI uses the Cloudflare-hosted store", () => {
		expect(resolveStateMode({CI: "true"})).toBe("cloudflare");
	});

	it("alchemy dev (ALCHEMY_EXEC_OPTIONS.dev=true) uses local state", () => {
		expect(
			resolveStateMode({ALCHEMY_EXEC_OPTIONS: JSON.stringify({dev: true, stage: "dev"})}),
		).toBe("local");
	});

	it("alchemy deploy via exec options (dev unset) still uses the shared store", () => {
		expect(
			resolveStateMode({ALCHEMY_EXEC_OPTIONS: JSON.stringify({stage: "prod"}), CI: "true"}),
		).toBe("cloudflare");
	});

	it("honors the ALCHEMY_DEV override", () => {
		expect(resolveStateMode({ALCHEMY_DEV: "1"})).toBe("local");
		expect(resolveStateMode({ALCHEMY_DEV: "true"})).toBe("local");
	});

	it("the integration harness (CI, no dev flag) uses the Cloudflare store — real remote D1 (ADR 0082)", () => {
		// ADR 0082: integration deploys to real remote Cloudflare via Test.make, so a
		// Vitest run resolves to the shared store like a real deploy. `VITEST` is no
		// longer an offline signal (it isn't even read), so a CI test run with no dev
		// flag resolves to cloudflare exactly like a real deploy.
		expect(resolveStateMode({CI: "true"})).toBe("cloudflare");
	});

	it("alchemy dev still uses local state under the integration run's ALCHEMY_DEV", () => {
		expect(resolveStateMode({CI: "true", ALCHEMY_DEV: "1"})).toBe("local");
	});

	it('does not treat CI="false" as remote (explicit signal, not bare truthiness)', () => {
		expect(resolveStateMode({CI: "false"})).toBe("cloudflare");
	});

	it("falls through to the shared store on a malformed ALCHEMY_EXEC_OPTIONS blob", () => {
		expect(resolveStateMode({ALCHEMY_EXEC_OPTIONS: "{not json"})).toBe("cloudflare");
	});
});
