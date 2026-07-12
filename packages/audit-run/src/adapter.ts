/**
 * The real {@link AuditWalk} + {@link AuditArchiver} — the thin wiring from the pure core
 * (`run.ts`) to the agentic explorer and the verdict archive. The core owns the
 * provision→walk→verdict→guaranteed-teardown sequence; this owns the side effects, and is
 * exercised only end to end (a real deploy + a real explorer walk), never in the unit tests.
 *
 * The agentic walk is NOT a faked LLM call. The rite-audit explorer is an LLM driving the
 * Playwright MCP, so it cannot run inside this TS process — instead the operator supplies the
 * walk as an external command (`--walk`), and this adapter SHELLS OUT to it: the live stage's
 * run context is handed over as `$RITE_AUDIT_RUN_CONTEXT` (JSON), the command drives the real
 * explorer against the real stage, and prints the raw findings bundle
 * (`{ "dimensions": DimensionResult[] }` — the explorer's output, what #1516 consumes) to
 * stdout, which this adapter parses. A walk that produces no dimensions, exits non-zero, or
 * prints malformed JSON fails loud (story 11: never silently pass), in the `run-hook` channel
 * so the lifecycle's guaranteed teardown still fires.
 */
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {type AuditRunInput, StageLifecycleError} from "@kampus/audit-stage";
import {
	archivePath,
	type DimensionResult,
	renderVerdictJson,
	renderVerdictMarkdown,
	type Verdict,
} from "@kampus/audit-verdict";
import {Effect, Stream} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import type {ArchivedVerdict, AuditArchiver, AuditWalk} from "./run.ts";

/** The env var the run context is handed to the operator-supplied walk command under. */
export const RUN_CONTEXT_ENV = "RITE_AUDIT_RUN_CONTEXT";

const decode = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const parseDimensions = (
	raw: string,
): Effect.Effect<ReadonlyArray<DimensionResult>, StageLifecycleError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new StageLifecycleError({
				phase: "run-hook",
				message: `walk command did not print valid JSON findings: ${String(cause)}`,
			}),
	}).pipe(
		Effect.flatMap((parsed) => {
			const dimensions =
				typeof parsed === "object" && parsed !== null
					? (parsed as {dimensions?: unknown}).dimensions
					: undefined;
			// Story 11: a walk that yields no dimensions is NEVER a silent pass — an empty findings
			// set would build a vacuous PASS verdict, so refuse it here at the seam that emits it.
			if (!Array.isArray(dimensions) || dimensions.length === 0) {
				return Effect.fail(
					new StageLifecycleError({
						phase: "run-hook",
						message:
							"walk command produced no dimensions ({ dimensions: DimensionResult[] } expected, non-empty)",
					}),
				);
			}
			return Effect.succeed(dimensions as ReadonlyArray<DimensionResult>);
		}),
	);

const spawnWalk = (
	command: string,
	input: AuditRunInput,
): Effect.Effect<
	ReadonlyArray<DimensionResult>,
	StageLifecycleError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make("sh", ["-c", command], {
				extendEnv: true,
				env: {[RUN_CONTEXT_ENV]: JSON.stringify(input)},
			});
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[decode(handle.stdout), decode(handle.stderr), handle.exitCode],
				{concurrency: "unbounded"},
			);
			if (exitCode !== 0) {
				return yield* new StageLifecycleError({
					phase: "run-hook",
					message: `walk command exited ${exitCode}: ${stderr.trim().slice(0, 600)}`,
				});
			}
			return yield* parseDimensions(stdout);
		}),
	).pipe(
		Effect.catchTag(
			"PlatformError",
			(cause) =>
				new StageLifecycleError({
					phase: "run-hook",
					message: `could not run the walk command: ${cause.message}`,
				}),
		),
	);

/**
 * Build the real walk seam from an operator-supplied command, capturing the spawner once so
 * the returned `AuditWalk` carries `R = never` (the `@kampus/audit-stage` adapter idiom).
 * Provide `NodeServices.layer` to satisfy the spawner requirement when running it.
 */
export const makeWalkFromCommand = (
	command: string,
): Effect.Effect<AuditWalk, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		return (input) =>
			spawnWalk(command, input).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			);
	});

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

/** Walk up from `from` for the repo root (the workspace/.git marker), so the archive lands repo-relative. */
export const findRepoRoot = (from: string): string => {
	let dir = resolve(from);
	for (;;) {
		if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(from);
		dir = parent;
	}
};

/**
 * The real archiver — write the verdict's JSON + Markdown renderings to the repo-relative
 * accumulating run log (`rite-audit/runs/`, #1516) under `repoRoot`. `archivePath` keeps the
 * cited paths repo-relative (it fails loud on any absolute/home/escaping path), so no local
 * path leaks into the artifact.
 */
export const makeFsArchiver =
	(repoRoot: string): AuditArchiver =>
	(verdict: Verdict) =>
		Effect.try({
			try: (): ArchivedVerdict => {
				const jsonRel = archivePath(verdict, "json");
				const mdRel = archivePath(verdict, "md");
				mkdirSync(join(repoRoot, dirname(jsonRel)), {recursive: true});
				writeFileSync(join(repoRoot, jsonRel), renderVerdictJson(verdict));
				writeFileSync(join(repoRoot, mdRel), renderVerdictMarkdown(verdict));
				return {jsonPath: jsonRel, mdPath: mdRel};
			},
			catch: (cause) =>
				new StageLifecycleError({
					phase: "run-hook",
					message: `could not archive the verdict: ${String(cause)}`,
				}),
		});
