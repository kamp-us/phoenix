/**
 * `control-plane-paths` — emit the canonical §CP boundary deterministically (issue #2761).
 *
 *   pipeline-cli control-plane-paths            # print CONTROL_PLANE_RE (the grep/jq regex)
 *   pipeline-cli control-plane-paths --paths    # print the expanded §CP path set, one per line
 *
 * The single-source emitter: the shell drift guard (`validate-gate-path-drift.sh`)
 * reads the regex from HERE instead of byte-comparing N hand-copied literals, so a
 * boundary change is one edit to the const, not the ~11-file lockstep the copies used
 * to force (#2673). The regex is printed with NO trailing formatting so `$(…)` capture
 * in bash yields exactly the value to compare against the formats-doc line.
 */
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {cpPaths} from "../codeowners-cp/codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

const pathsFlag = Flag.boolean("paths").pipe(
	Flag.withDescription("print the expanded §CP path set (one per line) instead of the regex"),
);

export const controlPlanePathsCommand = Command.make(
	"control-plane-paths",
	{paths: pathsFlag},
	Effect.fn(function* ({paths}) {
		if (paths) {
			for (const p of cpPaths(CONTROL_PLANE_RE)) yield* Console.log(p.path);
			return;
		}
		yield* Console.log(CONTROL_PLANE_RE);
	}),
).pipe(
	Command.withDescription(
		"Emit the canonical §CP CONTROL_PLANE_RE (the single source), or its expanded path set with --paths (#2761)",
	),
);
