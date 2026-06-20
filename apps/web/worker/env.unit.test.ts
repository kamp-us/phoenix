/** Unit tests for `resolveStateMode` + `customHostname` — deploy-time helpers. */
import {describe, expect, it} from "vitest";
import {customHostname, PHOENIX_APEX_HOSTNAME, resolveStateMode} from "./env.ts";

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

describe("customHostname (production-only — #594/#983)", () => {
	it("a production deploy serves the apex phoenix.kamp.us", () => {
		expect(customHostname("prod", "production")).toBe(PHOENIX_APEX_HOSTNAME);
		expect(customHostname("prod", "production")).toBe("phoenix.kamp.us");
	});

	it("every non-prod stage gets NO custom domain (undefined) — its worker.url stays *.workers.dev", () => {
		// No per-stage subdomain anymore: an ephemeral integration `it-*` stage, a preview
		// stage, and a named dev stage all resolve to undefined, so the integration harness
		// hits the workers.dev URL (valid cert) instead of an un-provisioned custom-domain TLS.
		expect(customHostname("preview", "preview")).toBeUndefined();
		expect(customHostname("dev_umut", "development")).toBeUndefined();
		expect(customHostname("it-abc123", "preview")).toBeUndefined();
	});

	it("prod is decided by ENVIRONMENT, not the stage name", () => {
		// A stage literally named "production" is still non-prod unless ENVIRONMENT says so —
		// fail-closed, mirrors isProductionDeploy → no domain, never the apex.
		expect(customHostname("production", "preview")).toBeUndefined();
		// And a prod ENVIRONMENT serves the apex regardless of the stage label.
		expect(customHostname("anything", "production")).toBe("phoenix.kamp.us");
	});
});
