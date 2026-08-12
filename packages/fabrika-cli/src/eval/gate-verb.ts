/**
 * `eval gate` — the IO shell around `gate.ts`'s judgement (#4681).
 *
 * The verb resolves **every** input the bar is decided over, so the CI job that calls it passes a PR
 * number and relays an exit code (ADR 0228). Nothing about the decision — which paths count as a
 * skill change, which record is in force, whether a rate clears the bar — is reachable from the
 * workflow file.
 *
 * Two modes, and the second is why the graded leg is checkable offline: with a PR number the head,
 * the changed paths and the eval records all come off the platform; with `--head` / `--changed` /
 * `--record` they come off disk, no credential and no network.
 *
 * The only thing this shell executes is the deterministic tier over the armed incident cases. It
 * spawns processes, never a model — `graded-axis.ts` is not imported here, which is what makes "no
 * model in CI" readable off the import list rather than asserted in prose.
 */
import {Effect, FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {listComments, resolveRepo} from "../io/issues.ts";
import {getPullRequest, listPullFiles} from "../io/pulls.ts";
import {readSpendLedger} from "../spend/ledger.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type EvalRecord, read as readEvalRecord} from "../wire/eval-record.ts";
import {type HeadSha, headSha} from "../wire/verdict-marker.ts";
import {MALFORMED_DOCUMENT, PRECONDITION_UNKNOWN, TARGET_ABSENT} from "./codes.ts";
import {
	type CostBaseline,
	compareToBaseline,
	decodeCostBaseline,
	foldLedgerRows,
} from "./cost-baseline.ts";
import {observeShellCommand} from "./deterministic-shell-observer.ts";
import {runDeterministicTier} from "./deterministic-tier.ts";
import {commandResolverOf, decodeFloorCommands} from "./floor-commands.ts";
import {
	changedSkills,
	decideGate,
	floorScope,
	gateToJson,
	judgeFloor,
	judgeGraded,
	judgeScope,
	judgeSpend,
	renderGate,
	type SpendInput,
} from "./gate.ts";
import {readSeriesFiles} from "./series-io.ts";
import {decodeSkillEvalSet} from "./skill-eval-set.ts";
import {readTrend} from "./trend.ts";

const VERB = "eval gate";

/** A committed v1 baseline's file name, as `eval baseline record --out` writes it into the series. */
const BASELINE_FILE_NAME = /^baseline-v1-\d{4}-\d{2}-\d{2}(?:-\d+)?\.json$/;

export interface GateOptions {
	/** The PR to gate. `null` selects the offline mode, which then owes head + changed + records. */
	readonly pr: number | null;
	readonly repo: string | null;
	readonly head: string | null;
	/** A file of newline-separated changed paths — the offline half of the platform's file list. */
	readonly changed: string | null;
	readonly records: ReadonlyArray<string>;
	readonly floorCases: string;
	readonly floorCommands: string;
	readonly seriesDir: string;
	readonly baseline: string | null;
	readonly ledger: string;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const readText = (path: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
	});

/** What the two modes have to agree on before any leg can be judged. */
interface Subject {
	readonly head: HeadSha;
	readonly changed: ReadonlyArray<string>;
	readonly records: ReadonlyArray<EvalRecord>;
	readonly diagnostics: ReadonlyArray<string>;
}

const resolveOnline = (
	options: GateOptions,
	pr: number,
): Effect.Effect<Subject | VerbOutcome, never, Services> =>
	Effect.gen(function* () {
		const target = yield* resolveRepo(options.repo, options.env);
		if (target._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = target.value;

		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent") {
			return refuse(TARGET_ABSENT, `${VERB}: PR #${pr} not found in ${repo}.`);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read PR #${pr}: ${found.reason} — the bar is UNKNOWN, never met.`,
			);
		}
		const live = headSha(found.value.headSha);
		if (live === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: PR #${pr}'s head "${found.value.headSha.trim()}" is not a head SHA — nothing to bind a record to.`,
			);
		}

		const files = yield* listPullFiles(repo, pr);
		if (files._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s changed files: ${files.reason} — a short file list would silently shrink the gate's scope.`,
			);
		}
		// The platform's own count is the denominator: a paged read that came back short would drop the
		// very skill path that makes the graded leg apply, which is the #4604 shape from the other side.
		if (files.value.length < found.value.changedFiles) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: received ${files.value.length} of ${found.value.changedFiles} declared changed file(s) on #${pr} — refusing the partial scope.`,
			);
		}

		const listed = yield* listComments(repo, pr);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s comments: ${listed.reason} — an unreadable comment list is never "no eval record".`,
			);
		}
		if (listed.value.length < found.value.comments) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: received ${listed.value.length} of ${found.value.comments} declared comment(s) on #${pr} — a short sweep could miss the record and red as missing.`,
			);
		}

		const records: Array<EvalRecord> = [];
		const notices: Array<string> = [];
		for (const comment of listed.value) {
			const carried = readEvalRecord(comment.body);
			// A comment that reaches for the format and fails it is named, never dropped: it may be the
			// record this gate is looking for, garbled, and a silent skip would red as `missing`.
			if (carried._tag === "Malformed") {
				notices.push(
					`${VERB}: comment ${comment.id} reaches for the eval-record format and fails it: ${carried.reason}.`,
				);
				continue;
			}
			if (carried._tag === "Found") records.push(carried.value);
		}
		return {
			head: live,
			changed: files.value,
			records,
			diagnostics: [
				`${VERB}: ${repo}#${pr} at ${live} — ${files.value.length} changed path(s), ${listed.value.length} comment(s) swept, ${records.length} eval record(s) read.`,
				...notices,
			],
		};
	});

const resolveOffline = (
	options: GateOptions,
): Effect.Effect<Subject | VerbOutcome, never, Services> =>
	Effect.gen(function* () {
		if (options.head === null || options.changed === null) {
			return refuse(
				FAILED,
				`${VERB}: name a pull request, or pass --head and --changed for the offline mode.`,
			);
		}
		const live = headSha(options.head);
		if (live === null) {
			return refuse(FAILED, `${VERB}: "${options.head}" is not a head SHA — expected 7-40 hex.`);
		}
		const listText = yield* readText(options.changed);
		if (listText === null) {
			return refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot read ${options.changed}.`);
		}
		const records: Array<EvalRecord> = [];
		for (const path of options.records) {
			const text = yield* readText(path);
			if (text === null) {
				return refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot read ${path}.`);
			}
			const carried = readEvalRecord(text);
			if (carried._tag !== "Found") {
				return refuse(
					MALFORMED_DOCUMENT,
					`${VERB}: ${path} carries no readable eval record (${carried._tag.toLowerCase()}): ${carried.reason}.`,
				);
			}
			records.push(carried.value);
		}
		const changed = listText
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
		return {
			head: live,
			changed,
			records,
			diagnostics: [
				`${VERB}: offline at ${live} — ${changed.length} changed path(s) from ${options.changed}, ${records.length} eval record(s) from disk.`,
			],
		};
	});

/** A step answered with a refusal rather than its value. `code` is the one key no step's value has. */
const isOutcome = <A extends object>(value: A | VerbOutcome): value is VerbOutcome =>
	Object.hasOwn(value, "code");

/** The newest committed v1 baseline in the series directory, or `null` when it carries none. */
const newestBaseline = (
	dir: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return null;
		const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
		const names = entries.filter((name) => BASELINE_FILE_NAME.test(name)).sort();
		const newest = names[names.length - 1];
		return newest === undefined ? null : path.join(dir, newest);
	});

const spendInput = (
	options: GateOptions,
): Effect.Effect<SpendInput | VerbOutcome, never, Services> =>
	Effect.gen(function* () {
		const ledgerText = yield* readText(options.ledger);
		if (ledgerText === null) return {_tag: "NoLedger", path: options.ledger} as SpendInput;

		const ledger = readSpendLedger(ledgerText);
		const baselinePath = options.baseline ?? (yield* newestBaseline(options.seriesDir));
		if (baselinePath === null) {
			return {_tag: "NoBaseline", dir: options.seriesDir} as SpendInput;
		}
		const baselineText = yield* readText(baselinePath);
		if (baselineText === null) {
			return refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot read ${baselinePath}.`);
		}
		const decoded = decodeCostBaseline(baselineText);
		if (Result.isFailure(decoded)) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: ${baselinePath} is not a valid cost baseline (${decoded.failure.reason}): ${decoded.failure.message}.`,
			);
		}
		const baseline: CostBaseline = decoded.success;
		const fold = foldLedgerRows(ledger.rows);
		// An unfoldable candidate is `incomparable`, which the spend leg reds — it is never a failure to
		// invoke, because the ceiling was read and the question was asked.
		return Result.isFailure(fold)
			? ({
					_tag: "Compared",
					comparison: {
						verdict: "incomparable",
						reason: fold.failure.message,
						baselineBilled: baseline.spend.billed,
						candidateBilled: 0,
						deltaBilled: null,
					},
				} as SpendInput)
			: ({
					_tag: "Compared",
					comparison: compareToBaseline(baseline, fold.success),
				} as SpendInput);
	});

export const runGate = (options: GateOptions): Effect.Effect<VerbOutcome, never, Services> =>
	Effect.gen(function* () {
		if (options.pr !== null && options.records.length > 0) {
			return refuse(
				FAILED,
				`${VERB}: --record is the offline mode's input; on a pull request the records are read from its comments.`,
			);
		}
		const subject = yield* options.pr === null
			? resolveOffline(options)
			: resolveOnline(options, options.pr);
		if (isOutcome(subject)) return subject;

		// The floor's two artifacts are read before anything runs: a corpus or a sidecar the gate
		// cannot read is UNKNOWN, and UNKNOWN never resolves to an empty floor that passes.
		const casesText = yield* readText(options.floorCases);
		if (casesText === null) {
			return refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot read ${options.floorCases}.`);
		}
		const set = decodeSkillEvalSet(casesText);
		if (Result.isFailure(set)) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: ${options.floorCases} is not a valid eval set (${set.failure.reason}): ${set.failure.message}.`,
			);
		}
		const commandsText = yield* readText(options.floorCommands);
		if (commandsText === null) {
			return refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot read ${options.floorCommands}.`);
		}
		const sidecar = decodeFloorCommands(commandsText);
		if (Result.isFailure(sidecar)) {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: ${options.floorCommands} is not a valid arming sidecar (${sidecar.failure.reason}): ${sidecar.failure.message}.`,
			);
		}

		const scope = floorScope(set.success.cases, sidecar.success);
		const run =
			scope.armed.length === 0
				? {rows: [], deferredToGraded: []}
				: yield* runDeterministicTier({
						cases: scope.armed,
						resolveCommand: commandResolverOf(sidecar.success),
						observe: observeShellCommand,
					});

		const series = yield* readSeriesFiles(options.seriesDir);
		if (series._tag !== "Files") {
			return refuse(
				series._tag === "Unreadable" ? PRECONDITION_UNKNOWN : MALFORMED_DOCUMENT,
				series._tag === "Unreadable"
					? `${VERB}: cannot read the scorecard series at ${series.path}.`
					: `${VERB}: ${series.path} is not a committable scorecard (${series.reason}).`,
			);
		}

		const spend = yield* spendInput(options);
		if (isOutcome(spend)) return spend;

		const skills = changedSkills(subject.changed);
		const verdict = decideGate({
			legs: [
				judgeScope(subject.changed),
				judgeFloor({
					scope,
					rows: run.rows,
					deterministicCases: set.success.cases.filter((c) => c.tier === "deterministic").length,
				}),
				judgeGraded({changedSkills: skills, records: subject.records, head: subject.head}),
				judgeSpend(spend),
			],
			trend: readTrend(series.files),
		});

		const report = options.json ? gateToJson(verdict) : `${renderGate(verdict)}\n`;
		return verdict.verdict === "green"
			? answer(report, subject.diagnostics)
			: refuse(verdict.code, report.trimEnd(), subject.diagnostics);
	});
