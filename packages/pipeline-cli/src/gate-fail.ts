/**
 * The shared guard fail path — one handler every `pipeline-cli <guard> check` routes its
 * `CheckFailed` through.
 *
 * It does what each guard's own copy did (report on stderr, exit non-zero) and adds the
 * one thing they all lacked: GitHub `::error` workflow commands on stdout, so a red guard
 * lands as an inline PR annotation instead of a log dig (#3868). Rendering and the
 * under-Actions gate live in `annotate.ts`; this file is the IO.
 *
 * The exit code is unchanged — red stays red, green stays green.
 */
import {Effect} from "effect";
import {type Annotation, gateFailureAnnotations, renderAnnotations} from "./annotate.ts";

const GATE_FAIL_EXIT_CODE = 1;

/**
 * The `CheckFailed` shape every guard already carries. `annotations` is the optional
 * enrichment a guard adds when it knows where the failure lives; omitting it yields one
 * bare `::error` carrying the report head.
 */
export interface GateFailure {
	readonly reason: string;
	readonly annotations?: ReadonlyArray<Annotation> | undefined;
}

/**
 * Report a gate failure and exit non-zero. Annotations go to **stdout** (where GitHub
 * parses workflow commands) and the human report stays on **stderr**, so neither stream
 * changes shape for the other's reader.
 */
export const reportGateFailure = (failure: GateFailure): Effect.Effect<void> =>
	Effect.sync(() => {
		process.stderr.write(`${failure.reason}\n`);
	}).pipe(
		// The report is the load-bearing output and is already out by here; annotations only
		// decorate it, so a failure to render degrades to "no annotations" rather than taking
		// the report with it (the same invariant `annotationsOrNone` holds on the build side).
		Effect.andThen(
			Effect.try(() => {
				for (const line of renderAnnotations(
					gateFailureAnnotations(failure.reason, failure.annotations ?? []),
					process.env,
				)) {
					process.stdout.write(`${line}\n`);
				}
			}).pipe(Effect.ignore),
		),
		Effect.andThen(
			Effect.sync(() => {
				process.exit(GATE_FAIL_EXIT_CODE);
			}),
		),
	);

/**
 * Build a guard's annotations, degrading to none if the build throws. A guard's
 * `CheckFailed({reason, annotations})` evaluates its `annotations` argument EAGERLY, so an
 * unguarded throw while computing them lands *before* the error carrying the report is
 * constructed — the whole human diagnostic dies exactly when the guard goes red. Every
 * guard that computes annotations builds them through this.
 */
export const annotationsOrNone = (
	build: () => ReadonlyArray<Annotation>,
): Effect.Effect<ReadonlyArray<Annotation>> =>
	Effect.try(build).pipe(Effect.orElseSucceed((): ReadonlyArray<Annotation> => []));

/** The `Effect.catchTag("CheckFailed", …)` handler each guard command wires in. */
export const onCheckFailed = (e: GateFailure): Effect.Effect<void> => reportGateFailure(e);

/** As `onCheckFailed`, for a guard whose report is printed under a tool-name prefix. */
export const onCheckFailedWithPrefix =
	(prefix: string) =>
	(e: GateFailure): Effect.Effect<void> =>
		reportGateFailure({reason: `${prefix}${e.reason}`, annotations: e.annotations});
