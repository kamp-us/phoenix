/**
 * Preloaded into every Node process of the example's test run (`NODE_OPTIONS=--import`). It appends
 * each module URL Node resolves to the file `TUVAL_RESOLVE_LOG` names, so the proof can read where
 * the run's imports actually landed. It is copied next to the example before the run, because a hook
 * loaded from the checkout would itself be a file the run resolved inside it.
 */
import {appendFileSync} from "node:fs";
import {registerHooks} from "node:module";

const log = process.env.TUVAL_RESOLVE_LOG;
if (log === undefined || log === "") throw new Error("TUVAL_RESOLVE_LOG names no log file");

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		appendFileSync(log, `${resolved.url}\n`);
		return resolved;
	},
});
