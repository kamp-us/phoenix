import {describe, expect, it} from "vitest";
import {
	isUnlinkedDependencyError,
	remediationMessage,
	unlinkedPackageName,
} from "./module-load-guard.ts";

/** A Node `ERR_MODULE_NOT_FOUND` for an unlinked bare specifier (the #1798 case). */
const unlinkedPkgErr = (pkg: string): Error & {code: string} =>
	Object.assign(
		new Error(`Cannot find package '${pkg}' imported from /repo/packages/pipeline-cli/src/x.ts`),
		{
			code: "ERR_MODULE_NOT_FOUND",
		},
	);

/** A Node `ERR_MODULE_NOT_FOUND` for a missing relative source file (a real bug — must NOT remediate). */
const missingRelativeFileErr = (): Error & {code: string} =>
	Object.assign(
		new Error(
			"Cannot find module '/repo/packages/pipeline-cli/src/gone.ts' imported from /repo/x.ts",
		),
		{
			code: "ERR_MODULE_NOT_FOUND",
		},
	);

describe("isUnlinkedDependencyError", () => {
	it("matches an ERR_MODULE_NOT_FOUND for an unlinked package (the yaml/#1798 case)", () => {
		expect(isUnlinkedDependencyError(unlinkedPkgErr("yaml"))).toBe(true);
	});

	it("does NOT match a missing relative source file (a real bug, not install-timing)", () => {
		expect(isUnlinkedDependencyError(missingRelativeFileErr())).toBe(false);
	});

	it("does NOT match a different error code", () => {
		const other = Object.assign(new Error("boom"), {code: "ERR_SOMETHING_ELSE"});
		expect(isUnlinkedDependencyError(other)).toBe(false);
	});

	it("does NOT match non-error values", () => {
		expect(isUnlinkedDependencyError(null)).toBe(false);
		expect(isUnlinkedDependencyError(undefined)).toBe(false);
		expect(isUnlinkedDependencyError("Cannot find package 'yaml'")).toBe(false);
	});
});

describe("unlinkedPackageName", () => {
	it("extracts the package name from the Node message", () => {
		expect(unlinkedPackageName("Cannot find package 'yaml' imported from /x.ts")).toBe("yaml");
	});

	it("returns null for a message without the package shape", () => {
		expect(
			unlinkedPackageName("Cannot find module '/repo/gone.ts' imported from /x.ts"),
		).toBeNull();
	});
});

describe("remediationMessage", () => {
	it("names the missing package and points at both install commands", () => {
		const msg = remediationMessage(unlinkedPkgErr("yaml"));
		expect(msg).toContain("`yaml`");
		expect(msg).toContain("pnpm install");
		expect(msg).toContain("pnpm --filter @kampus/pipeline-cli install");
		// no raw stack framing
		expect(msg).not.toContain("ERR_MODULE_NOT_FOUND");
	});

	it("covers the general case (any dep, not just yaml)", () => {
		expect(remediationMessage(unlinkedPkgErr("effect"))).toContain("`effect`");
	});

	it("degrades to a generic phrasing when the package name is unresolvable", () => {
		const weird = Object.assign(new Error("Cannot find package"), {code: "ERR_MODULE_NOT_FOUND"});
		expect(remediationMessage(weird)).toContain("a dependency");
	});
});
