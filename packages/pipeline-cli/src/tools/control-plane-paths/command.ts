/**
 * `control-plane-paths` — emit the canonical §CP boundary deterministically (issue #2761).
 *
 *   pipeline-cli control-plane-paths                       # print CONTROL_PLANE_RE (the grep/jq regex)
 *   pipeline-cli control-plane-paths --paths               # print the expanded §CP path set, one per line
 *   pipeline-cli control-plane-paths --boundary HAS_CODE_RE  # print one single-sourced gate boundary
 *   pipeline-cli control-plane-paths --boundary-names      # list every single-sourced boundary name
 *
 * The single-source emitter: the shell drift guard (`validate-gate-path-drift.sh`)
 * reads the regex from HERE instead of byte-comparing N hand-copied literals, so a
 * boundary change is one edit to the const, not the ~11-file lockstep the copies used
 * to force (#2673). The regex is printed with NO trailing formatting so `$(…)` capture
 * in bash yields exactly the value to compare against the formats-doc line.
 *
 * `--boundary` extends that same read to the ten boundaries #4401 gave a typed source
 * (`src/gate-boundaries.ts`), so the validator locks every prose `_RE=` line the same way rather
 * than only `CONTROL_PLANE_RE`. It lives in THIS enumerated §CP tool deliberately: the emitter is
 * what the validator trusts, so an emitter that could be edited without control-plane sign-off
 * could lie to the guard about what the boundary is.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {GATE_BOUNDARIES} from "../../gate-boundaries.ts";
import {cpPaths} from "../codeowners-cp/codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

/** Every boundary with a typed source, under the canonical shell-assignment name the prose uses. */
const ALL_BOUNDARIES: Readonly<Record<string, string>> = {CONTROL_PLANE_RE, ...GATE_BOUNDARIES};

const pathsFlag = Flag.boolean("paths").pipe(
	Flag.withDescription("print the expanded §CP path set (one per line) instead of the regex"),
);

const boundaryFlag = Flag.string("boundary").pipe(
	Flag.optional,
	Flag.withDescription("print one single-sourced gate boundary by its canonical name"),
);

const boundaryNamesFlag = Flag.boolean("boundary-names").pipe(
	Flag.withDescription("list every single-sourced gate-boundary name, one per line"),
);

export const controlPlanePathsCommand = Command.make(
	"control-plane-paths",
	{paths: pathsFlag, boundary: boundaryFlag, boundaryNames: boundaryNamesFlag},
	Effect.fn(function* ({paths, boundary, boundaryNames}) {
		if (boundaryNames) {
			for (const name of Object.keys(ALL_BOUNDARIES)) yield* Console.log(name);
			return;
		}
		if (Option.isSome(boundary)) {
			const value = ALL_BOUNDARIES[boundary.value];
			// Exit non-zero on an unknown name rather than printing nothing: a silent empty read is
			// precisely the trivial-pattern failure this whole surface exists to make impossible.
			if (value === undefined) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`control-plane-paths: unknown boundary '${boundary.value}' — known: ${Object.keys(ALL_BOUNDARIES).join(", ")}\n`,
					),
				);
				return yield* Effect.sync(() => process.exit(1));
			}
			yield* Console.log(value);
			return;
		}
		if (paths) {
			for (const p of cpPaths(CONTROL_PLANE_RE)) yield* Console.log(p.path);
			return;
		}
		yield* Console.log(CONTROL_PLANE_RE);
	}),
).pipe(
	Command.withDescription(
		"Emit the canonical §CP CONTROL_PLANE_RE (the single source), its expanded path set with --paths, or any single-sourced gate boundary with --boundary (#2761, #4401)",
	),
);
