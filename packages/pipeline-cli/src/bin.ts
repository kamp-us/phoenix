#!/usr/bin/env node
/**
 * `pipeline-cli` — the subcommand-router bin (epic #994, Phase-1 scaffold #996).
 *
 *   node src/bin.ts --help        # list the registered tools
 *   node src/bin.ts version       # the Phase-1 tracer tool
 *   node src/bin.ts <tool> …      # dispatch to a registered tool (Phase-2 children)
 *
 * The router itself lives in `run.ts` (`Command.withSubcommands(registeredTools)`);
 * this file is a thin bootstrap that loads it via a **dynamic** `import()` so an
 * unlinked `catalog:` dep — the in-repo-first path hit before `pnpm install` has
 * settled on a fresh/partial checkout — is a *catchable* `ERR_MODULE_NOT_FOUND`
 * (#1798) instead of a raw static-load throw. On catch, `loadWithSelfHeal` first
 * tries a bounded one-shot `pnpm install` + retry (the #2459 self-heal — see its
 * docblock in `module-load-guard.ts`); only if that still can't link the dep does
 * the legible remediation print and the bin exit(1) (the #1798 fallback, preserved).
 * On the normal (installed) path this is a plain pass-through.
 */
import {spawnSync} from "node:child_process";
import {existsSync, lstatSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {findRootDir} from "./find-root-dir.ts";
import {
	assertSelfHealInstallSafe,
	isUnlinkedDependencyError,
	loadWithSelfHeal,
	remediationMessage,
	SELF_HEAL_INSTALL_ARGS,
	shouldSelfHeal,
} from "./module-load-guard.ts";

const load = () => import("./run.ts");

/** One-shot workspace install at the repo root — the side-effecting half of the #2459 self-heal. */
const install = async (): Promise<void> => {
	const here = dirname(fileURLToPath(import.meta.url));
	const rootDir =
		findRootDir(here, (dir) => existsSync(join(dir, "pnpm-workspace.yaml")), dirname) ??
		process.cwd();
	console.error(
		"pipeline-cli: an unlinked workspace dep — self-healing with a one-shot `pnpm install`…",
	);
	// Refuse before pnpm runs if rootDir/node_modules is a symlink — a hook-invoked
	// destructive install would otherwise follow it into the shared primary and purge it (#3504).
	assertSelfHealInstallSafe(rootDir, (p) => (existsSync(p) ? lstatSync(p) : null));
	// Non-TTY stdin (`ignore`) so pnpm can never (auto-)confirm a purge prompt; with the
	// armed `--config.confirm-modules-purge=true` it aborts on a purge instead (#3504).
	const result = spawnSync("pnpm", [...SELF_HEAL_INSTALL_ARGS], {
		cwd: rootDir,
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (result.status !== 0) {
		throw new Error(
			`pipeline-cli self-heal: \`pnpm install\` failed (exit ${result.status ?? `signal ${result.signal}`}) — cannot link deps`,
		);
	}
};

try {
	await loadWithSelfHeal({load, install, selfHealEnabled: shouldSelfHeal(process.env)});
} catch (err) {
	if (isUnlinkedDependencyError(err)) {
		console.error(remediationMessage(err));
		process.exit(1);
	}
	throw err;
}
