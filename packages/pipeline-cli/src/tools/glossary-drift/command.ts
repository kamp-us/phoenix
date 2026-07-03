/**
 * The `glossary-drift` tool — `pipeline-cli glossary-drift sweep`.
 *
 * The out-of-band backstop of ADR 0128 prong (b) (issue #1748): it diffs recent
 * merges against `.glossary/TERMS.md` and surfaces concept-level vocabulary drift the
 * fail-closed `review-code` Step 3c gate structurally cannot see (a coined term in a
 * regular code PR that never routes through `/adr` or `plan-epic` — the #1726
 * release-lever redefinition class).
 *
 *   pipeline-cli glossary-drift sweep                 # print candidate drift (window=25), exit 0
 *   pipeline-cli glossary-drift sweep --window 50     # widen the merge window
 *   pipeline-cli glossary-drift sweep --file-issue    # on drift, file a status:needs-triage issue via gh
 *   pipeline-cli glossary-drift sweep --terms <path>  # point at a specific TERMS.md (else: repo root)
 *
 * This is **off the per-PR blocking path by construction**: it exits 0 whether or not
 * drift is found (a hit is a *filed issue*, never a non-zero gate exit), so it can never
 * block a merge. It is meant to run on a schedule (`.github/workflows/glossary-drift.yml`),
 * not in CI's PR checks. The lag between a term shipping and the next sweep filing it is
 * the deliberate ADR-0128 price of keeping this off the fail-closed gate.
 *
 * The pure decision (parse TERMS, extract candidates, decide drift, render the report /
 * issue body) lives in `drift.ts`; the git-log parse into `MergeLine[]` is the pure
 * `parseGitLog` in `gitlog.ts`. This file is the thin IO seam: it shells out to `git log`
 * and `gh`, reads the file, and wires the core to the CLI — mirroring `changelog-derive`
 * (git/gh IO at the boundary, a total core behind it).
 */
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Console, Data, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../doc-links/doc-links.ts";
import {findDrift, parseKnownTerms, renderIssueBody, renderReport} from "./drift.ts";
import {GIT_LOG_RECORD_SEP, parseGitLog} from "./gitlog.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;
const DEFAULT_WINDOW = 25;

/** A shell-out (git/gh) or file-read failure — the run couldn't complete (non-zero exit). */
class SweepIoError extends Data.TaggedError("SweepIoError")<{
	readonly step: string;
	readonly cause: unknown;
}> {}

const defaultRoot = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return root ?? start;
};

const windowFlag = Flag.integer("window").pipe(
	Flag.optional,
	Flag.withDescription(`how many recent first-parent merges to sweep (default: ${DEFAULT_WINDOW})`),
);

const termsFlag = Flag.string("terms").pipe(
	Flag.optional,
	Flag.withDescription("path to TERMS.md (default: <repo-root>/.glossary/TERMS.md)"),
);

const fileIssueFlag = Flag.boolean("file-issue").pipe(
	Flag.withDescription(
		"on detected drift, file a status:needs-triage issue via gh (default: print only)",
	),
);

/** Read the recent merge window as a single record-separated blob, parsed by the pure core. */
const gatherMergeLog = (window: number): Effect.Effect<string, SweepIoError> =>
	Effect.try({
		try: () =>
			execFileSync(
				"git",
				["log", "--first-parent", `-${window}`, `--pretty=format:%s%n%b${GIT_LOG_RECORD_SEP}`],
				{encoding: "utf8", maxBuffer: 32 * 1024 * 1024},
			),
		catch: (cause) => new SweepIoError({step: "git log", cause}),
	});

const readTerms = (path: string): Effect.Effect<string, SweepIoError> =>
	Effect.try({
		try: () => readFileSync(path, "utf8"),
		catch: (cause) => new SweepIoError({step: `read ${path}`, cause}),
	});

/** File the drift as a status:needs-triage issue via `gh` (the report skill's intake path). */
const fileDriftIssue = (title: string, body: string): Effect.Effect<string, SweepIoError> =>
	Effect.try({
		try: () =>
			execFileSync(
				"gh",
				["issue", "create", "--title", title, "--body", body, "--label", "status:needs-triage"],
				{encoding: "utf8"},
			).trim(),
		catch: (cause) => new SweepIoError({step: "gh issue create", cause}),
	});

const onIoError = (e: SweepIoError) =>
	Effect.sync(() => {
		process.stderr.write(`glossary-drift: ${e.step} failed: ${String(e.cause)}\n`);
		process.exit(1);
	});

const sweep = Command.make(
	"sweep",
	{window: windowFlag, terms: termsFlag, fileIssue: fileIssueFlag},
	Effect.fn(function* ({window: windowOpt, terms: termsOpt, fileIssue}) {
		const window = Option.getOrElse(windowOpt, () => DEFAULT_WINDOW);
		const termsPath = Option.getOrElse(termsOpt, () =>
			join(defaultRoot(), ".glossary", "TERMS.md"),
		);

		yield* Effect.gen(function* () {
			const [logBlob, termsMd] = yield* Effect.all([gatherMergeLog(window), readTerms(termsPath)]);
			const lines = parseGitLog(logBlob);
			const known = parseKnownTerms(termsMd);
			const drift = findDrift(lines, known);

			yield* Console.log(renderReport(drift, lines.length));

			if (drift.length > 0 && fileIssue) {
				const title = `glossary-drift: ${drift.length} candidate concept-level term(s) from recent merges`;
				const url = yield* fileDriftIssue(title, renderIssueBody(drift, lines.length));
				yield* Console.error(`glossary-drift: filed drift issue ${url}`);
			}
			// Exit 0 whether or not drift was found — this NEVER blocks a merge (ADR 0128).
		}).pipe(Effect.catchTag("SweepIoError", onIoError));
	}),
).pipe(
	Command.withDescription(
		"Sweep recent merges for concept-level vocab drift vs .glossary/TERMS.md (out-of-band, ADR 0128 (b))",
	),
);

export const glossaryDriftCommand = Command.make("glossary-drift").pipe(
	Command.withSubcommands([sweep]),
	Command.withDescription(
		"Out-of-band glossary-drift backstop: diff recent merges vs .glossary/TERMS.md (ADR 0128 prong (b), #1748)",
	),
);
