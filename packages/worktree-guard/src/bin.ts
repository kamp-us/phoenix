/**
 * `worktree-guard` entrypoint — thin dependency preflight in front of the Effect runtime.
 *
 * A static `import "@effect/platform-node"` would throw `ERR_MODULE_NOT_FOUND` at
 * module-load on a not-yet-installed tree, *before* any handling runs, and the harness
 * would silently fail-open (the worktree-pinning hooks enforcing nothing). So this
 * entrypoint resolves the runtime dep FIRST (#777, pure, imports nothing) and only then
 * dynamically loads the heavy `bin.run.ts`. On a stale tree it degrades LOUD per
 * subcommand — never a silent no-op:
 *
 *   - pre-file / pre-bash / pre-enter → fail-open `allow` JSON + stderr note (matches
 *     worktree-guard's documented unset-root no-op posture).
 *   - reap                            → skip + stderr note.
 */
import {degradedAllow, depsInstalled, missingDepMessage} from "./preflight.ts";

if (depsInstalled()) {
	await import("./bin.run.ts");
} else {
	const subcommand = process.argv[2] ?? "<no subcommand>";
	console.error(missingDepMessage(subcommand));
	// reap (SubagentStop) emits no stdout; the PreToolUse subcommands emit a fail-open allow.
	if (subcommand !== "reap") console.log(degradedAllow());
}
