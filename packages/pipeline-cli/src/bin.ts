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
 * settled on a fresh/partial checkout — surfaces as an actionable remediation
 * instead of a raw `ERR_MODULE_NOT_FOUND` from deep in the static tool graph
 * (#1798). A static `import "./run.ts"` would link that graph before any code
 * here runs, so the throw could not be caught; the dynamic import is what makes
 * the module-not-found catchable. On the normal (installed) path this is a plain
 * pass-through — `run.ts` wires and runs the CLI exactly as before.
 */
import {isUnlinkedDependencyError, remediationMessage} from "./module-load-guard.ts";

try {
	await import("./run.ts");
} catch (err) {
	if (isUnlinkedDependencyError(err)) {
		console.error(remediationMessage(err));
		process.exit(1);
	}
	throw err;
}
