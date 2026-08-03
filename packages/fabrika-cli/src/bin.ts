#!/usr/bin/env node
/**
 * `fabrika-cli` — the bin.
 *
 *   node src/bin.ts --help          # list the registered verb groups
 *   node src/bin.ts adr --help      # one group's verbs, flags and exit codes
 *   node src/bin.ts adr next        # run a verb
 *
 * The router lives in `run.ts`; this file is a thin bootstrap that loads it via a **dynamic**
 * `import()` so an unlinked `catalog:` dep — the path hit on a fresh checkout before
 * `pnpm install` has settled — is a *catchable* `ERR_MODULE_NOT_FOUND` with a legible remediation
 * instead of a raw static-load throw. On the normal path this is a plain pass-through.
 */

// `await` at the top level needs this file to be a module, and it has no other import or export.
export {};

// The `try/catch` here is deliberate and stays native: this is a pre-runtime bootstrap — the module
// graph is being loaded to BUILD the CLI, so there is no Effect runtime yet to carry it in an `E`
// channel. Nothing in this file imports `effect`, which is what keeps that honest.
try {
	await import("./run.ts");
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes("ERR_MODULE_NOT_FOUND") || message.includes("Cannot find package")) {
		// Exit 2, not 1: this is "could not resolve an implementation", the same reserved code the
		// shim uses, so a resolution failure never reads as a verb's own usage error (#4666). The
		// remedy is stated conditionally on purpose — `pnpm install` is right for your own checkout
		// and wrong for a marketplace-managed plugin clone, which the harness owns and re-syncs.
		console.error(
			`fabrika-cli: a dependency is not linked (${message}).\n` +
				"If this is your own phoenix checkout, run `pnpm install` at its root and re-run.\n" +
				"If it is a marketplace-managed plugin clone, do not install into it — fabrika has no\n" +
				"working implementation outside a phoenix checkout until @kampus/fabrika-cli is\n" +
				"published (#4786).",
		);
		process.exit(2);
	}
	throw err;
}
