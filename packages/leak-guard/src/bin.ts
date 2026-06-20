/**
 * `leak-guard` entrypoint — thin dependency preflight in front of the Effect runtime.
 *
 * A static `import "@effect/platform-node"` would throw `ERR_MODULE_NOT_FOUND` at
 * module-load on a not-yet-installed tree, *before* any handling runs — an unhandled
 * crash with a confusing stack rather than leak-guard's intentional exit-code signal.
 * So this entrypoint resolves the runtime dep FIRST (#777, pure, imports nothing) and
 * only then dynamically loads the heavy `bin.run.ts`. On a stale tree it exits LOUD with
 * the documented "could not run" code (NOT 0=clean, NOT 2=leak) so the existing #332
 * contract routes it: pre-commit warns+allows, CI fails.
 */
import {CANT_RUN_EXIT_CODE, depsInstalled, missingDepMessage} from "./preflight.ts";

if (depsInstalled()) {
	await import("./bin.run.ts");
} else {
	console.error(missingDepMessage());
	process.exit(CANT_RUN_EXIT_CODE);
}
