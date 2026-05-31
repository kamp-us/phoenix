/**
 * Unit tests for `resolveStateMode` — the deploy-time state-store selector that
 * runs in the alchemy CLI process when `worker/index.ts` is evaluated.
 *
 * Pure over an injected `env` snapshot so the behavior is testable without
 * touching the real `process.env`.
 */
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

	it("the VITEST harness uses local state even when CI is set", () => {
		expect(resolveStateMode({CI: "true", VITEST: "true"})).toBe("local");
	});

	it('does not treat CI="false" as remote (explicit signal, not bare truthiness)', () => {
		// CI is irrelevant to the store choice now — without a dev signal this is a
		// real deploy, so it resolves to the shared store regardless of CI's value.
		expect(resolveStateMode({CI: "false"})).toBe("cloudflare");
	});

	it("falls through to the shared store on a malformed ALCHEMY_EXEC_OPTIONS blob", () => {
		expect(resolveStateMode({ALCHEMY_EXEC_OPTIONS: "{not json"})).toBe("cloudflare");
	});
});
