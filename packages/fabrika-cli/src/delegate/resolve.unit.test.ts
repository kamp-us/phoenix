import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {faultingShell, signalledExitError, signalledShell} from "../fakes.test-support.ts";
import {NO_IMPLEMENTATION} from "../verb.ts";
import {type LocalInstall, PACKAGE_NAME, probeLocalInstall} from "./local.ts";
import {type RepoPredicate, repoPredicate} from "./reason.ts";
import type {CopyOrigin} from "./repository.ts";
import {
	foreignCheckoutRefusal,
	GLOBAL_WARNING_DISABLED_ENV,
	globalWarning,
	resolve,
	SKIP_INFER_FLAG,
	signalFromError,
	spawnDelegate,
	traceLine,
} from "./resolve.ts";

const install: LocalInstall = {
	packageRoot: "/repo/packages/fabrika-cli",
	manifestPath: "/repo/node_modules/@kampus/fabrika-cli/package.json",
	binPath: "/repo/packages/fabrika-cli/src/bin.ts",
	version: "0.1.0",
};

const GLOBAL = "/usr/local/pnpm/global/5/node_modules/@kampus/fabrika-cli";

/** A copy on `PATH`: it belongs to no repository to cross out of, so it may always hand over. */
const INSTALLED: CopyOrigin = {_tag: "same-repository"};

/** A copy whose checkout is a genuinely different repository — the one state that refuses. */
const OTHER_CHECKOUT = "/elsewhere";
const otherCopy = `${OTHER_CHECKOUT}/packages/fabrika-cli`;
const ELSEWHERE: CopyOrigin = {_tag: "other-repository", checkout: OTHER_CHECKOUT};

describe("resolve", () => {
	it("delegates to the repo-local install — the pinned version wins over the global", () => {
		expect(
			resolve({
				selfPackageRoot: GLOBAL,
				origin: INSTALLED,
				repoRoot: "/repo",
				local: {_tag: "found", install},
			}),
		).toEqual({_tag: "delegate", to: install});
	});

	it("runs here SILENTLY outside any repo — a global-only invocation is not a defect", () => {
		const resolution = resolve({
			selfPackageRoot: GLOBAL,
			origin: INSTALLED,
			repoRoot: undefined,
			local: undefined,
		});
		expect(resolution._tag).toBe("run-here");
	});

	it("WARNS when a repo root exists but nothing is installed — the quietly-wrong case", () => {
		const resolution = resolve({
			selfPackageRoot: GLOBAL,
			origin: INSTALLED,
			repoRoot: "/repo",
			local: {_tag: "absent"},
		});
		expect(resolution._tag).toBe("warn-and-run-here");
	});

	it("warns rather than throws on a corrupt local — the worst outcome is running the global", () => {
		const resolution = resolve({
			selfPackageRoot: GLOBAL,
			origin: INSTALLED,
			repoRoot: "/repo",
			local: {_tag: "corrupt", reason: repoPredicate`declares no version`},
		});
		expect(resolution).toEqual({
			_tag: "warn-and-run-here",
			repoRoot: "/repo",
			reason: "declares no version",
		});
	});

	it("runs here when the install it found IS this copy, rather than spawning itself", () => {
		const resolution = resolve({
			selfPackageRoot: install.packageRoot,
			origin: INSTALLED,
			repoRoot: "/repo",
			local: {_tag: "found", install},
		});
		expect(resolution._tag).toBe("run-here");
	});

	/**
	 * The recursion guard's second, independent half: the delegated child lands here with the cwd's
	 * repo root and its own package root, and must proceed rather than spawn itself again — including
	 * on the worktree hop, where the parent reached the child ACROSS working trees.
	 */
	it("runs here in the child of a worktree hop, where the install found is the child itself", () => {
		const worktreeInstall: LocalInstall = {
			...install,
			packageRoot: "/repo/.claude/worktrees/lane/packages/fabrika-cli",
			binPath: "/repo/.claude/worktrees/lane/packages/fabrika-cli/src/bin.ts",
		};
		expect(
			resolve({
				selfPackageRoot: worktreeInstall.packageRoot,
				origin: {_tag: "same-repository"},
				repoRoot: "/repo/.claude/worktrees/lane",
				local: {_tag: "found", install: worktreeInstall},
			})._tag,
		).toBe("run-here");
	});
});

/**
 * The two cases #4956 fused, and the third #5679 split back out. All three reach the delegate
 * comparison with `selfPackageRoot` outside the cwd's repo root, so `origin` is the only fact
 * separating them — and these assertions disagree on the outcome, which is what makes a future edit
 * that drops the field fail rather than quietly restore the wrong answer.
 */
describe("resolve — an install, a worktree peer and a foreign checkout are NOT the same input", () => {
	const input = {repoRoot: "/repo", local: {_tag: "found", install}} as const;

	it("REFUSES a copy invoked out of a different repository, naming both roots", () => {
		const resolution = resolve({...input, selfPackageRoot: otherCopy, origin: ELSEWHERE});
		expect(resolution).toEqual({
			_tag: "refuse-foreign-checkout",
			selfPackageRoot: otherCopy,
			selfCheckout: OTHER_CHECKOUT,
			repoRoot: "/repo",
			wouldHaveRun: install,
		});
	});

	it("still delegates SILENTLY from an install that belongs to no checkout — same comparison, opposite answer", () => {
		expect(resolve({...input, selfPackageRoot: GLOBAL, origin: INSTALLED})).toEqual({
			_tag: "delegate",
			to: install,
		});
	});

	/**
	 * #5679: the copy on `PATH` is a link into the primary checkout, so it belongs to a checkout — but
	 * the cwd's worktree is that same repository, and refusing there is what made the bare `fabrika`
	 * unusable from every worktree.
	 */
	it("delegates from another WORKING TREE of the same repository — a peer is not foreign", () => {
		expect(
			resolve({
				...input,
				selfPackageRoot: "/primary/packages/fabrika-cli",
				origin: {_tag: "same-repository"},
			}),
		).toEqual({_tag: "delegate", to: install});
	});

	it("delegates within ONE checkout — the pinned install may differ from the copy you ran", () => {
		expect(
			resolve({
				...input,
				selfPackageRoot: "/repo/vendor/fabrika-cli",
				origin: {_tag: "same-repository"},
			}),
		).toEqual({_tag: "delegate", to: install});
	});
});

describe("foreignCheckoutRefusal", () => {
	it("names both checkouts, the answer it declined to give, and both ways out", () => {
		const text = foreignCheckoutRefusal({
			selfPackageRoot: otherCopy,
			selfCheckout: OTHER_CHECKOUT,
			repoRoot: "/repo",
			wouldHaveRun: install,
		});
		expect(text).toContain(otherCopy);
		expect(text).toContain(OTHER_CHECKOUT);
		expect(text).toContain("/repo");
		expect(text).toContain(install.binPath);
		expect(text).toContain(SKIP_INFER_FLAG);
	});
});

describe("globalWarning", () => {
	/**
	 * The reasons come off their real producers, never a literal: the defect was the *splice* between
	 * the template and whatever each producer hands it, so a test that supplies its own clause tests
	 * the one arrangement that was never broken (#6027).
	 */
	const warn = (reason: RepoPredicate, declared: string | undefined, repoRoot = "/repo") =>
		globalWarning({repoRoot, reason, globalVersion: "0.1.0", declared});

	const firstLine = (text: string) => text.split("\n")[0];

	const absentReason = (): RepoPredicate => {
		const resolution = resolve({
			selfPackageRoot: GLOBAL,
			origin: INSTALLED,
			repoRoot: "/repo",
			local: {_tag: "absent"},
		});
		if (resolution._tag !== "warn-and-run-here") throw new Error("expected the loud branch");
		return resolution.reason;
	};

	/**
	 * A real repo on disk whose installed manifest is well-formed JSON but declares no `version`.
	 *
	 * Deliberately not unparseable JSON: Node's own resolver rejects that before the probe reads it,
	 * so the reason would come from `node-resolve.ts` wrapping a Node error string that changes
	 * between runtime versions. This shape reaches `local.ts`'s branch and is stable.
	 */
	const corruptProbe = async (): Promise<{
		readonly reason: RepoPredicate;
		readonly repoRoot: string;
	}> => {
		const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "fabrika-corrupt-")));
		const installed = join(repoRoot, "node_modules", PACKAGE_NAME);
		mkdirSync(installed, {recursive: true});
		writeFileSync(join(repoRoot, "package.json"), "{}");
		writeFileSync(join(installed, "package.json"), '{"name":"@kampus/fabrika-cli"}');
		try {
			const probed = await Effect.runPromise(
				probeLocalInstall(repoRoot).pipe(Effect.provide(NodeServices.layer)),
			);
			if (probed._tag !== "corrupt") throw new Error(`expected corrupt, got ${probed._tag}`);
			return {reason: probed.reason, repoRoot};
		} finally {
			rmSync(repoRoot, {recursive: true, force: true});
		}
	};

	it("reads as one sentence on the absent branch, not a path with a clause jammed after it", () => {
		expect(firstLine(warn(absentReason(), "^0.4.0"))).toBe(
			"fabrika: running the GLOBAL install (v0.1.0) — /repo has no local install.",
		);
	});

	it("reads as one sentence on a corrupt branch too", async () => {
		const {reason, repoRoot} = await corruptProbe();
		expect(firstLine(warn(reason, "^0.4.0", repoRoot))).toBe(
			`fabrika: running the GLOBAL install (v0.1.0) — ${repoRoot} has an unusable install: ` +
				`${join(repoRoot, "node_modules", PACKAGE_NAME, "package.json")} declares no "version".`,
		);
	});

	it("names BOTH versions — the global's and the one the repo declared", () => {
		const text = warn(absentReason(), "^0.4.0");
		expect(text).toContain("v0.1.0");
		expect(text).toContain("^0.4.0");
		expect(text).toContain("/repo");
		expect(text).toContain(GLOBAL_WARNING_DISABLED_ENV);
	});

	it("says so plainly when the repo declares no dependency at all", () => {
		expect(warn(absentReason(), undefined)).toContain("declares no @kampus/fabrika-cli dependency");
	});
});

describe("traceLine", () => {
	it("names both copies on a delegation, so the hop is checkable from outside", () => {
		const line = traceLine(
			GLOBAL,
			resolve({
				selfPackageRoot: GLOBAL,
				origin: INSTALLED,
				repoRoot: "/repo",
				local: {_tag: "found", install},
			}),
		);
		expect(line).toContain(GLOBAL);
		expect(line).toContain(install.packageRoot);
		expect(line).toContain(install.binPath);
	});

	it("says why it stayed put, not merely that it did", () => {
		const line = traceLine(
			GLOBAL,
			resolve({
				selfPackageRoot: GLOBAL,
				origin: INSTALLED,
				repoRoot: undefined,
				local: undefined,
			}),
		);
		expect(line).toContain("not inside a repo");
	});
});

describe("signalFromError", () => {
	/**
	 * The regression test that matters: the operand is the error the spawner really fails with, not a
	 * literal the caller never supplies. Reading `.message` — the shape this once had — sees only
	 * `Unknown: ChildProcess.exitCode (…)`, so the assertion pair below fails the pre-fix code.
	 */
	it("reads the signal out of the nested cause of a real spawner PlatformError", () => {
		const error = signalledExitError("SIGINT", `/usr/bin/node ${install.binPath} --skip-infer adr`);
		expect(error.message).not.toContain("SIGINT");
		expect(signalFromError(error)).toBe("SIGINT");
	});

	it("answers undefined for a spawn fault — which must never read as a signal death", () => {
		expect(
			signalFromError(
				PlatformError.badArgument({
					module: "ChildProcess",
					method: "spawn",
					description: "spawn node ENOENT",
				}),
			),
		).toBeUndefined();
	});
});

describe("spawnDelegate", () => {
	it("answers NO_IMPLEMENTATION — not the child's verdict — when the spawn itself faults", async () => {
		const outcome = await Effect.runPromise(
			spawnDelegate({
				execPath: "/usr/bin/node",
				binPath: install.binPath,
				args: ["adr", "next"],
				cwd: "/repo",
				invocationDir: "/repo/packages/fabrika-cli",
			}).pipe(Effect.provide(faultingShell)),
		);
		expect(outcome).toEqual({_tag: "exited", status: NO_IMPLEMENTATION});
	});

	it("reports a signal-killed child as signalled, never as the could-not-run diagnosis", async () => {
		const outcome = await Effect.runPromise(
			spawnDelegate({
				execPath: "/usr/bin/node",
				binPath: install.binPath,
				args: ["adr", "next"],
				cwd: "/repo",
				invocationDir: "/repo/packages/fabrika-cli",
			}).pipe(Effect.provide(signalledShell("SIGINT"))),
		);
		expect(outcome).toEqual({_tag: "signalled", signal: "SIGINT"});
	});

	/**
	 * The end-to-end anchor: a genuinely signalled child through the REAL spawner, so the fix stays
	 * bound to the dependency's actual error shape rather than to our reproduction of it.
	 */
	it("reports a genuinely SIGINT-killed child, spawned through the real platform spawner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fabrika-signal-"));
		const child = join(dir, "kills-itself.js");
		writeFileSync(child, "process.kill(process.pid, 'SIGINT');\nsetTimeout(() => {}, 5000);\n");
		try {
			const outcome = await Effect.runPromise(
				spawnDelegate({
					execPath: process.execPath,
					binPath: child,
					args: [],
					cwd: dir,
					invocationDir: dir,
				}).pipe(Effect.provide(NodeServices.layer)),
			);
			expect(outcome).toEqual({_tag: "signalled", signal: "SIGINT"});
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});
});
