/**
 * Unit coverage for `deriveAuthUrlConfig` — the per-deploy-class better-auth
 * origin/cookie derivation (#982, follow-on from the #594/#983 Custom Domain).
 *
 * The derivation is pure over the `environment` literal, so each class's
 * origin/cookie contract is wrong-or-right with NO alchemy provider stack:
 *
 *   - production pins `baseURL` to the `phoenix.kamp.us` apex (the live Custom
 *     Domain) so better-auth trusts exactly that origin for CSRF and scopes the
 *     session cookie to the apex HOST — NOT broadened to `.kamp.us` (ADR 0085
 *     no-widening; a `.kamp.us` cookie would leak to sibling apps). The apex is
 *     single-sourced from `PHOENIX_APEX_HOSTNAME`, so this test also pins that the
 *     auth-trusted origin can't silently drift from the bound domain.
 *   - preview trusts only the `*.kampusinfra.workers.dev` previews (#983 keeps the
 *     Custom Domain production-only, so no `*.phoenix.kamp.us` preview host exists).
 *   - development names the localhost browser origins behind the Vite proxy (#704).
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_APEX_HOSTNAME} from "../../env.ts";
import {deriveAuthUrlConfig} from "./better-auth-live.ts";

describe("deriveAuthUrlConfig", () => {
	it("production pins baseURL to the phoenix.kamp.us apex, host-scoped (no .kamp.us widening)", () => {
		const config = deriveAuthUrlConfig("production");

		assert.strictEqual(config.baseURL, `https://${PHOENIX_APEX_HOSTNAME}`);
		assert.strictEqual(config.baseURL, "https://phoenix.kamp.us");
		// No trustedOrigins add-on (SPA + API are same-origin), and crucially NO
		// crossSubDomainCookies / `.kamp.us` cookie domain — the cookie stays host-scoped.
		assert.isUndefined(config.trustedOrigins);
		assert.isUndefined(config.advanced?.crossSubDomainCookies);
	});

	it("preview trusts only the workers.dev previews, never a phoenix.kamp.us host", () => {
		const config = deriveAuthUrlConfig("preview");

		assert.deepStrictEqual(config.baseURL, {
			allowedHosts: ["*.kampusinfra.workers.dev"],
		});
		const baseURL = config.baseURL;
		assert.isFalse(
			typeof baseURL === "object" &&
				baseURL.allowedHosts.some((h) => h.includes("phoenix.kamp.us")),
		);
	});

	it("audit shares preview's deployed workers.dev topology, never the prod apex (#1511)", () => {
		const config = deriveAuthUrlConfig("audit");

		// The rite-audit stage is served from `*.kampusinfra.workers.dev`, so it must use
		// the dynamic allowedHosts mechanism — NOT fall through to the production apex pin.
		assert.deepStrictEqual(config.baseURL, {
			allowedHosts: ["*.kampusinfra.workers.dev"],
		});
		assert.notStrictEqual(config.baseURL, `https://${PHOENIX_APEX_HOSTNAME}`);
	});

	it("development names the localhost browser origins behind the Vite proxy", () => {
		const config = deriveAuthUrlConfig("development");

		assert.strictEqual(config.baseURL, "http://localhost:3000");
		assert.deepStrictEqual(config.trustedOrigins, [
			"http://localhost:3000",
			"http://localhost:5173",
		]);
	});

	it("no environment trusts a blanket .kamp.us origin (ADR 0085 no CSRF widening)", () => {
		for (const environment of ["development", "preview", "production", "audit"] as const) {
			const serialized = JSON.stringify(deriveAuthUrlConfig(environment));
			// `phoenix.kamp.us` (production) is allowed; a bare `.kamp.us` / `*.kamp.us`
			// blanket is the leak ADR 0085 forbids.
			assert.isFalse(
				/["*.]kamp\.us/.test(serialized.replace(/phoenix\.kamp\.us/g, "")),
				`environment "${environment}" must not trust a blanket .kamp.us origin`,
			);
		}
	});
});
