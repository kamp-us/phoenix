/**
 * `spawn-guard` entrypoint — thin dependency preflight in front of the Effect runtime.
 *
 * A static `import "@effect/platform-node"` would throw `ERR_MODULE_NOT_FOUND` at
 * module-load on a not-yet-installed tree, *before* any handling runs: the `guard`
 * PreToolUse hook would then exit non-zero with no JSON and the harness would silently
 * fail-open (the spawn-model allowlist enforcing nothing), and the statusline would
 * blank visibly (#758). So this entrypoint resolves the runtime dep FIRST (#777, pure,
 * imports nothing) and only then dynamically loads the heavy `bin.run.ts`. On a stale
 * tree it degrades LOUD per subcommand — never a silent no-op:
 *
 *   - `guard`      → fail-CLOSED `deny` JSON + stderr note (ADR 0092: an indeterminate
 *                    guard blocks, it does not silently allow).
 *   - `statusline` → a visible placeholder line + stderr note.
 *   - anything else → stderr note + non-zero exit (the CLI couldn't run).
 */
import {
	degradedGuardDeny,
	degradedStatusline,
	depsInstalled,
	missingDepMessage,
} from "./preflight.ts";

if (depsInstalled()) {
	await import("./bin.run.ts");
} else {
	const subcommand = process.argv[2] ?? "";
	console.error(missingDepMessage(subcommand || "<no subcommand>"));
	switch (subcommand) {
		case "guard":
			console.log(degradedGuardDeny());
			break;
		case "statusline":
			console.log(degradedStatusline());
			break;
		default:
			process.exit(1);
	}
}
