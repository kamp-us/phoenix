/**
 * Unit tests for `resolveDeployEnv` — the deploy-time env resolution that runs
 * in the alchemy CLI process when `worker/index.ts` is evaluated.
 *
 * The two values it owns are safety-critical:
 *   - `ENVIRONMENT` gates every dev-only surface (admin seeders, `AdminAuth`,
 *     the magic-link token `console.log`). A hardcoded `"development"` opens
 *     them in production.
 *   - `BETTER_AUTH_SECRET` signs sessions. A silent fallback to a committed dev
 *     secret ships forgeable sessions if a deploy forgets the real one.
 *
 * `resolveDeployEnv` is a pure function over an injected `env` snapshot so the
 * fail-closed behavior is testable without touching the real `process.env`.
 */
import {describe, expect, it} from "vitest";
import {DEV_BETTER_AUTH_SECRET, resolveDeployEnv, resolveStateMode} from "./deploy-env.ts";

describe("resolveDeployEnv", () => {
	describe("ENVIRONMENT", () => {
		it("defaults to development when unset", () => {
			const {ENVIRONMENT} = resolveDeployEnv({});
			expect(ENVIRONMENT).toBe("development");
		});

		it("resolves from process.env.ENVIRONMENT when set", () => {
			const {ENVIRONMENT} = resolveDeployEnv({ENVIRONMENT: "production"});
			expect(ENVIRONMENT).toBe("production");
		});
	});

	describe("BETTER_AUTH_SECRET — offline/dev path", () => {
		it("falls back to the dev secret when no CI and no real secret", () => {
			const {BETTER_AUTH_SECRET} = resolveDeployEnv({});
			expect(BETTER_AUTH_SECRET).toBe(DEV_BETTER_AUTH_SECRET);
		});

		it("falls back to the dev secret under VITEST even when CI is set", () => {
			const {BETTER_AUTH_SECRET} = resolveDeployEnv({CI: "true", VITEST: "true"});
			expect(BETTER_AUTH_SECRET).toBe(DEV_BETTER_AUTH_SECRET);
		});

		it("prefers a real secret when one is provided on the dev path", () => {
			const {BETTER_AUTH_SECRET} = resolveDeployEnv({BETTER_AUTH_SECRET: "real-secret"});
			expect(BETTER_AUTH_SECRET).toBe("real-secret");
		});
	});

	describe("BETTER_AUTH_SECRET — real deploy (fail closed)", () => {
		it("throws on a real deploy (CI, no VITEST) when the secret is unset", () => {
			expect(() => resolveDeployEnv({CI: "true"})).toThrow(/BETTER_AUTH_SECRET/);
		});

		it("does not fall back to the known dev secret on a real deploy", () => {
			let resolved: string | undefined;
			try {
				resolved = resolveDeployEnv({CI: "true"}).BETTER_AUTH_SECRET;
			} catch {
				resolved = undefined;
			}
			expect(resolved).not.toBe(DEV_BETTER_AUTH_SECRET);
		});

		it("passes through the real secret on a real deploy", () => {
			const {BETTER_AUTH_SECRET} = resolveDeployEnv({CI: "true", BETTER_AUTH_SECRET: "prod"});
			expect(BETTER_AUTH_SECRET).toBe("prod");
		});

		it('treats CI="false" as the dev path (explicit signal, not bare truthiness)', () => {
			const {BETTER_AUTH_SECRET} = resolveDeployEnv({CI: "false"});
			expect(BETTER_AUTH_SECRET).toBe(DEV_BETTER_AUTH_SECRET);
		});
	});
});

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
