#!/usr/bin/env node
/**
 * `fabrika` — the bin.
 *
 *   node src/bin.ts --help          # list the registered verb groups
 *   node src/bin.ts adr --help      # one group's verbs, flags and exit codes
 *   node src/bin.ts adr next        # run a verb
 *
 * Two things happen here, in order. First the **delegation**: the copy on `PATH` finds the repo root
 * above the cwd and hands the invocation to the install that repo pins
 * ([`delegate/entry.ts`](./delegate/entry.ts) — the shape turbo ships, #4784). Then the router in
 * `run.ts`, loaded via a **dynamic** `import()` so an unlinked `catalog:` dep — the path hit on a
 * fresh checkout before `pnpm install` has settled — is a *catchable* `ERR_MODULE_NOT_FOUND` with a
 * legible remediation instead of a raw static-load throw.
 */

// `await` at the top level needs this file to be a module, and it has no other import or export.
export {};

// The `try/catch` here is deliberate and stays native: this is a pre-runtime bootstrap — the module
// graph is being loaded to BUILD the CLI, so there is no Effect runtime yet to carry it in an `E`
// channel. Nothing in this file imports `effect`, which is what keeps that honest.
try {
	const {delegateOrRunHere} = await import("./delegate/entry.ts");
	await delegateOrRunHere();
	await import("./run.ts");
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes("ERR_MODULE_NOT_FOUND") || message.includes("Cannot find package")) {
		// Exit 2, not 1: this is "could not resolve an implementation", which must not read as a
		// verb's own usage error (#4666). The remedy is stated conditionally on purpose — `pnpm
		// install` is right for a phoenix checkout and wrong for a globally installed copy, whose
		// dependencies came with the tarball.
		console.error(
			`fabrika: a dependency is not linked (${message}).\n` +
				"If this is a phoenix checkout, run `pnpm install` at its root and re-run.\n" +
				"If this is a global install, reinstall it: `pnpm add -g @kampus/fabrika-cli`.",
		);
		process.exit(2);
	}
	throw err;
}
