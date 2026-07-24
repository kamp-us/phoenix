#!/usr/bin/env node
/**
 * `depo` — the CLI bin (ADR 0144 decision 5). A thin bootstrap over `run.ts`,
 * loaded via a dynamic `import()` so an unlinked `catalog:` dep — the path hit on
 * a fresh/partial checkout before `pnpm install` settles — surfaces as an
 * actionable remediation instead of a raw `ERR_MODULE_NOT_FOUND` deep in the tool
 * graph. On the normal (installed) path this is a plain pass-through.
 *
 *   node src/bin.ts put ./shot.png     # upload, print the public URL
 */
export {};

try {
	await import("./run.ts");
} catch (err) {
	if (
		err instanceof Error &&
		"code" in err &&
		(err as {code?: unknown}).code === "ERR_MODULE_NOT_FOUND"
	) {
		console.error(
			`depo: a dependency is not linked (${err.message}).\n` +
				"Run `pnpm install` at the repo root, then retry.",
		);
		process.exit(1);
	}
	throw err;
}
