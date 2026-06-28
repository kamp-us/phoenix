/**
 * Unit tests for the deploy-environment taxonomy module (ADR 0088) — the single
 * owner of `isProduction`, the `stage → ENVIRONMENT` map, and the fail-LOUD
 * unknown-env guard that closes the silent fail-open downgrade (#1433).
 */
import {describe, expect, it} from "vitest";
import {
	AUDIT_ENVIRONMENT,
	AUDIT_STAGE,
	DEFAULT_ENVIRONMENT,
	ENVIRONMENTS,
	environmentForStage,
	isEnvironment,
	isProduction,
	isProductionDeploy,
	parseDeployEnvironment,
	UnknownEnvironmentError,
} from "./environment.ts";

describe("the taxonomy (ADR 0088, + the `audit` class #1511)", () => {
	it("is exactly the four deploy classes", () => {
		expect(ENVIRONMENTS).toEqual(["development", "preview", "production", "audit"]);
	});

	it("fail-closes to production when ENVIRONMENT is unset", () => {
		expect(DEFAULT_ENVIRONMENT).toBe("production");
	});

	it("the audit class is its own literal, distinct from production", () => {
		expect(AUDIT_ENVIRONMENT).toBe("audit");
		expect(AUDIT_ENVIRONMENT).not.toBe("production");
	});

	it("recognizes each class and rejects anything else", () => {
		expect(isEnvironment("development")).toBe(true);
		expect(isEnvironment("preview")).toBe(true);
		expect(isEnvironment("production")).toBe(true);
		expect(isEnvironment("audit")).toBe(true);
		expect(isEnvironment("prod")).toBe(false);
		expect(isEnvironment("")).toBe(false);
	});
});

describe("isProduction (the one shared predicate)", () => {
	it("is true only for production", () => {
		expect(isProduction("production")).toBe(true);
		expect(isProduction("preview")).toBe(false);
		expect(isProduction("development")).toBe(false);
		// The audit class is NEVER production — the prod-never invariant at the taxonomy layer.
		expect(isProduction("audit")).toBe(false);
	});
});

describe("parseDeployEnvironment (fail-loud guard, #1433)", () => {
	it("returns the typed class for a known value", () => {
		expect(parseDeployEnvironment("production")).toBe("production");
		expect(parseDeployEnvironment("preview")).toBe("preview");
		expect(parseDeployEnvironment("development")).toBe("development");
		expect(parseDeployEnvironment("audit")).toBe("audit");
	});

	it("treats a genuinely absent value as undefined (caller defaults), NOT as a class", () => {
		// Absence is the local `alchemy deploy` / unset case — the deploy gates read this as
		// non-prod, preserving the prior `=== "production"` behavior. It is NOT a fail-open
		// downgrade because the value was never a recognized class to begin with.
		expect(parseDeployEnvironment(undefined)).toBeUndefined();
		expect(parseDeployEnvironment("")).toBeUndefined();
	});

	it("THROWS on a non-empty unrecognized value instead of silently failing open", () => {
		// The #1433 hazard: CI emitting the stage spelling `prod` instead of `production`.
		// Before, every gate fell through to non-prod on a green deploy; now it fails loud.
		expect(() => parseDeployEnvironment("prod")).toThrow(UnknownEnvironmentError);
		expect(() => parseDeployEnvironment("staging")).toThrow(UnknownEnvironmentError);
		expect(() => parseDeployEnvironment("Production")).toThrow(UnknownEnvironmentError);
	});
});

describe("isProductionDeploy (the deploy-time gate over process.env)", () => {
	it("is true only for an explicit production ENVIRONMENT", () => {
		expect(isProductionDeploy({ENVIRONMENT: "production"})).toBe(true);
		expect(isProductionDeploy({ENVIRONMENT: "preview"})).toBe(false);
		expect(isProductionDeploy({ENVIRONMENT: "development"})).toBe(false);
	});

	it("treats an absent ENVIRONMENT as non-production (fail-closed for provisioning)", () => {
		expect(isProductionDeploy({})).toBe(false);
		expect(isProductionDeploy({ENVIRONMENT: undefined})).toBe(false);
		expect(isProductionDeploy({ENVIRONMENT: ""})).toBe(false);
	});

	it("THROWS on an unknown ENVIRONMENT rather than downgrading to non-prod (#1433)", () => {
		expect(() => isProductionDeploy({ENVIRONMENT: "prod"})).toThrow(UnknownEnvironmentError);
	});
});

describe("environmentForStage (the single owner of the prod→production map)", () => {
	it("maps the main-push stage `prod` to `production`", () => {
		expect(environmentForStage("prod")).toBe("production");
	});

	it("maps the dedicated audit stage to the `audit` class (#1511)", () => {
		expect(environmentForStage(AUDIT_STAGE)).toBe("audit");
		expect(environmentForStage("audit")).toBe("audit");
	});

	it("maps every other stage (per-PR previews) to `preview`", () => {
		expect(environmentForStage("pr-1433")).toBe("preview");
		expect(environmentForStage("it-abc123")).toBe("preview");
		expect(environmentForStage("dev_umut")).toBe("preview");
	});

	it("never maps a non-prod stage to production (prod-never at the stage layer)", () => {
		// The audit stage and every preview stay non-production: only `prod` is production,
		// so the audit force-on rule can never reach a production deploy.
		expect(environmentForStage(AUDIT_STAGE)).not.toBe("production");
		expect(environmentForStage("pr-1")).not.toBe("production");
	});
});
