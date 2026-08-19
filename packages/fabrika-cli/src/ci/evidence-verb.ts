/**
 * `ci evidence` — map one crabbox run to the ADR 0054 §2 run-evidence manifest.
 *
 * The producer half of the evidence seam: `run-evidence.yml` runs this on every PR head and
 * publishes the result as the `run-evidence` artifact, which `fabrika ship evidence` then reads
 * back and binds to the head SHA. The manifest never lands half-formed — a malformed input or an
 * unresolvable commit refuses with nothing written, because a commit-blank manifest would unbind
 * the evidence from the commit the gate keys on (ADR 0054 §1).
 *
 * The commit is stamped from `--commit` when the caller knows the head (on `pull_request` that is
 * the head SHA, NOT `github.sha`'s synthetic merge commit), else resolved from `HEAD` here.
 */

import {Effect, type FileSystem, type Path, Schema} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readFile, writeFile} from "../io/fs.ts";
import {resolveCommit} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {buildManifest} from "./adapter.ts";
import {MALFORMED_DOCUMENT, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {parseJUnit, parseRunSummaryJson} from "./crabbox.ts";
import {Check, manifestToJson} from "./manifest.ts";

const VERB = "ci evidence";

/** An `--extra-checks` file: a single `Check` object OR an array of them. */
const decodeExtraChecks = Schema.decodeUnknownEffect(Schema.Union([Check, Schema.Array(Check)]));

export interface EvidenceOptions {
	/** Path to crabbox's machine-readable run-summary JSON. */
	readonly runSummary: string;
	/** Path to the `--artifact-glob`'d JUnit XML, or `null` for zeroed tests. */
	readonly junit: string | null;
	/** Reference (path/URL) to the captured run logs. */
	readonly logs: string;
	/** The head SHA to stamp, or `null` to resolve `HEAD` in this tree. */
	readonly commit: string | null;
	readonly runUrl: string | null;
	readonly environment: string | null;
	/** Write the manifest here instead of returning it on stdout. */
	readonly output: string | null;
	/** Path to a JSON `Check` (or `Check[]`) produced outside crabbox, folded into `checks[]`. */
	readonly extraChecks: string | null;
}

const read = (path: string): Effect.Effect<string, VerbOutcome, FileSystem.FileSystem> =>
	readFile(path).pipe(
		Effect.mapError((failure) =>
			refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${path}: ${failure.reason} — the manifest rests on it, so nothing is written.`,
			),
		),
	);

const stampedCommit = (
	provided: string | null,
): Effect.Effect<string, VerbOutcome, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (provided !== null && provided.trim() !== "") return provided.trim();
		const resolved = yield* resolveCommit("HEAD");
		if (resolved._tag === "Failure") {
			return yield* Effect.fail(
				refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${resolved.reason} — \`commit\` is the binding key the gate asserts against, so a blank one is never stamped (ADR 0054 §1).`,
				),
			);
		}
		return resolved.value;
	});

export const runCiEvidence = (
	options: EvidenceOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const summary = yield* parseRunSummaryJson(yield* read(options.runSummary)).pipe(
			Effect.mapError((cause) =>
				refuse(MALFORMED_DOCUMENT, `${VERB}: ${options.runSummary}: ${cause.message}`),
			),
		);
		const tests = parseJUnit(options.junit === null ? null : yield* read(options.junit));
		const extraChecks =
			options.extraChecks === null
				? []
				: yield* Effect.flatMap(read(options.extraChecks), (text) =>
						Effect.try({
							try: () => JSON.parse(text) as unknown,
							catch: (cause) =>
								refuse(
									MALFORMED_DOCUMENT,
									`${VERB}: ${options.extraChecks} is not valid JSON: ${String(cause)}.`,
								),
						}).pipe(
							Effect.flatMap((raw) =>
								decodeExtraChecks(raw).pipe(
									Effect.map((decoded) => (Array.isArray(decoded) ? decoded : [decoded])),
									Effect.mapError((cause) =>
										refuse(
											MALFORMED_DOCUMENT,
											`${VERB}: ${options.extraChecks} is not a Check or Check[]: ${String(cause)}.`,
										),
									),
								),
							),
						),
					);

		const json = manifestToJson(
			buildManifest({
				summary,
				tests,
				commit: yield* stampedCommit(options.commit),
				logsRef: options.logs,
				timestamp: summary.finishedAt ?? new Date().toISOString(),
				extraChecks,
				...(options.runUrl === null ? {} : {runUrl: options.runUrl}),
				...(options.environment === null ? {} : {environment: options.environment}),
			}),
		);

		if (options.output === null) return answer(json);
		const output = options.output;
		yield* writeFile(output, json).pipe(
			Effect.mapError((failure) =>
				refuse(
					WRITE_UNKNOWN,
					`${VERB}: cannot write ${output}: ${failure.reason} — whether the manifest landed is UNKNOWN.`,
				),
			),
		);
		return answer("", [`${VERB}: wrote the manifest to ${output}`]);
	}).pipe(Effect.catch(Effect.succeed));
