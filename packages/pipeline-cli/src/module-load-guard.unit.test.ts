import {describe, expect, it, vi} from "vitest";
import {
	assertSelfHealInstallSafe,
	isUnlinkedDependencyError,
	loadWithSelfHeal,
	remediationMessage,
	SELF_HEAL_INSTALL_ARGS,
	selfHealSymlinkRefusal,
	shouldSelfHeal,
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

describe("shouldSelfHeal", () => {
	it("is on by default when the opt-out env var is unset", () => {
		expect(shouldSelfHeal({})).toBe(true);
	});

	it("is off when the opt-out env var is set to a truthy value", () => {
		expect(shouldSelfHeal({PIPELINE_CLI_NO_SELF_HEAL: "1"})).toBe(false);
		expect(shouldSelfHeal({PIPELINE_CLI_NO_SELF_HEAL: "yes"})).toBe(false);
	});

	it("treats falsey values as unset so `VAR=0`/`VAR=` doesn't accidentally arm it", () => {
		expect(shouldSelfHeal({PIPELINE_CLI_NO_SELF_HEAL: ""})).toBe(true);
		expect(shouldSelfHeal({PIPELINE_CLI_NO_SELF_HEAL: "0"})).toBe(true);
		expect(shouldSelfHeal({PIPELINE_CLI_NO_SELF_HEAL: "false"})).toBe(true);
	});
});

describe("SELF_HEAL_INSTALL_ARGS", () => {
	it("keeps pnpm's purge guard ARMED (=true), never disarms it (=false)", () => {
		// pnpm 10.27.0 `purgeModulesDirsOfImporters`: `confirmModulesPurge ?? true` + non-TTY
		// THROWS ABORTED_REMOVE_MODULES_DIR_NO_TTY; `=false` purges silently. We must pass `=true`.
		expect(SELF_HEAL_INSTALL_ARGS).toContain("--config.confirm-modules-purge=true");
		expect(SELF_HEAL_INSTALL_ARGS).not.toContain("--config.confirm-modules-purge=false");
		expect(SELF_HEAL_INSTALL_ARGS[0]).toBe("install");
	});
});

describe("assertSelfHealInstallSafe", () => {
	const symlink = {isSymbolicLink: () => true};
	const realDir = {isSymbolicLink: () => false};

	it("REFUSES when repo-root node_modules is a symlink (the #3504 corruption vector)", () => {
		const lstat = vi.fn().mockReturnValue(symlink);
		expect(() => assertSelfHealInstallSafe("/repo", lstat)).toThrow(/is a symlink/);
		expect(lstat).toHaveBeenCalledWith("/repo/node_modules");
	});

	it("proceeds when node_modules is a real directory (the normal primary/main-sync self-heal)", () => {
		expect(() =>
			assertSelfHealInstallSafe("/repo", vi.fn().mockReturnValue(realDir)),
		).not.toThrow();
	});

	it("proceeds when node_modules is absent (a fresh checkout — nothing to follow)", () => {
		expect(() => assertSelfHealInstallSafe("/repo", vi.fn().mockReturnValue(null))).not.toThrow();
	});

	it("the refusal names the corruption class and the offending path", () => {
		const msg = selfHealSymlinkRefusal("/repo/node_modules");
		expect(msg).toContain("/repo/node_modules");
		expect(msg).toContain("#3504");
		expect(msg).toContain("symlink");
	});
});

describe("loadWithSelfHeal", () => {
	it("passes through when the first load succeeds — no install", async () => {
		const load = vi.fn().mockResolvedValue(undefined);
		const install = vi.fn().mockResolvedValue(undefined);
		await expect(loadWithSelfHeal({load, install})).resolves.toBeUndefined();
		expect(load).toHaveBeenCalledTimes(1);
		expect(install).not.toHaveBeenCalled();
	});

	it("self-heals the unlinked-dep case: one install, then the retry succeeds", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(unlinkedPkgErr("@kampus/ci-required"))
			.mockResolvedValueOnce(undefined);
		const install = vi.fn().mockResolvedValue(undefined);
		const onHealAttempt = vi.fn();
		await expect(loadWithSelfHeal({load, install, onHealAttempt})).resolves.toBeUndefined();
		// bounded: exactly one install, exactly one retry (two loads total) — never a loop
		expect(install).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledTimes(2);
		expect(onHealAttempt).toHaveBeenCalledWith("@kampus/ci-required");
	});

	it("falls back to the #1798 remediation when the retry still can't link the dep", async () => {
		const stillUnlinked = unlinkedPkgErr("@kampus/ci-required");
		const load = vi.fn().mockRejectedValue(stillUnlinked);
		const install = vi.fn().mockResolvedValue(undefined);
		// the second unlinked throw propagates so the bin prints remediation + exit(1)
		await expect(loadWithSelfHeal({load, install})).rejects.toBe(stillUnlinked);
		expect(install).toHaveBeenCalledTimes(1); // still bounded — one install, no loop
		expect(load).toHaveBeenCalledTimes(2);
		expect(isUnlinkedDependencyError(stillUnlinked)).toBe(true);
	});

	it("does NOT self-heal a genuine missing-source-file miss — rethrows the real bug untouched", async () => {
		const realBug = missingRelativeFileErr();
		const load = vi.fn().mockRejectedValue(realBug);
		const install = vi.fn().mockResolvedValue(undefined);
		await expect(loadWithSelfHeal({load, install})).rejects.toBe(realBug);
		expect(install).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("skips the heal entirely when disabled — the unlinked error drops straight to the fallback", async () => {
		const unlinked = unlinkedPkgErr("yaml");
		const load = vi.fn().mockRejectedValue(unlinked);
		const install = vi.fn().mockResolvedValue(undefined);
		await expect(loadWithSelfHeal({load, install, selfHealEnabled: false})).rejects.toBe(unlinked);
		expect(install).not.toHaveBeenCalled();
		expect(load).toHaveBeenCalledTimes(1);
	});
});
