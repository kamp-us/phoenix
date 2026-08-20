/**
 * `ledger open` — prove the ground fresh, allocate the run, read what already exists, rank duplicate
 * candidates.
 *
 * The run directory is created **here and nowhere else**; every later verb re-derives it from the
 * claim nonce and refuses if it is gone. Three facts are decided once, here, and read off `run.json`
 * afterwards rather than carried in anyone's head: the run's `mode`, the `cycleDoc` reading, and the
 * body digest the two guarded verbs are held to.
 *
 * **A re-open is a resume, not a reset.** `runKey` comes from the claim nonce, which a re-open does not
 * change, so this verb finds the previous attempt's files. It re-seeds `children.jsonl` from the live
 * sub-issue list and **leaves `plan.md` and `topology.md` untouched** — re-staging either is `ledger
 * draft`'s and `ledger topology`'s job, and silently discarding a staged document a caller has not
 * replaced would lose authored work with no refusal to notice.
 */

import {Effect, FileSystem, Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {scannedLine} from "../build/target.ts";
import {readTree} from "../build/tree.ts";
import {cycleDocOr} from "../config/paths.ts";
import {searchOpenIssues} from "../io/issues.ts";
import {probeCycleDoc} from "../plan/github.ts";
import {sectionCount} from "../plan/ledger.ts";
import {rank, tokenize} from "../report/dedup.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, REGION_UNRESOLVABLE, STALE_GROUND} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {listSubIssueEntries, openBacklog} from "./github.ts";
import {commitsBehind} from "./ground.ts";
import {PLAN_HEADING} from "./plan-block.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {
	type ChildRecord,
	EXCLUDE_ENTRY,
	manifestPath,
	parseManifest,
	renderManifest,
	renderRunRecord,
	runJsonPath,
} from "./run.ts";

const VERB = "ledger open";

/** How many candidates the dedup rank prints. The advisory list is read by a human, not scanned. */
const CANDIDATE_LIMIT = 20;

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to plan it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — the ground is UNKNOWN.`,
};

export const runOpen = (
	options: OpenOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
> =>
	Effect.gen(function* () {
		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, dir, notes} = ground;

		const planAnchors = sectionCount(epic.body, "Plan (plan-epic)");
		if (planAnchors > 1) {
			return refuse(
				REGION_UNRESOLVABLE,
				`${VERB}: #${epic.number}'s body carries ${planAnchors} "${PLAN_HEADING}" headings — the plan mode has no single meaning.`,
				notes,
			);
		}
		const mode = planAnchors === 0 ? "fresh" : "re-plan";

		const behind = yield* commitsBehind();
		if (behind._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable("this tree's distance from origin/main", behind.reason),
				notes,
			);
		}
		if (behind.value > 0) {
			return refuse(
				STALE_GROUND,
				`${VERB}: base is ${behind.value} commit(s) behind origin/main — a plan derived here is derived on stale ground (#3330).`,
				notes,
			);
		}

		const children = yield* listSubIssueEntries(options.env, repo, epic.number);
		if (children._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`#${epic.number}'s sub-issue list`, children.reason),
				notes,
			);
		}

		const cycle = yield* cycleDocOr(
			VERB,
			options.cwd,
			"where the cycle doc lives is unread, so the containment class cannot be derived.",
		);
		if (cycle._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, cycle.message, notes);
		const cycleDoc = yield* probeCycleDoc(repo, cycle.path, options.env);

		const tokens = tokenize(epic.title);
		const backlog = yield* openBacklog(options.env, repo);
		if (backlog._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`${repo}'s open backlog`, backlog.reason),
				notes,
			);
		}
		const search = yield* searchOpenIssues(repo, tokens);
		if (search._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`${repo}'s search index`, search.reason),
				notes,
			);
		}
		const ranked = rank({
			tokens,
			queue: backlog.value,
			search: search.value,
			limit: CANDIDATE_LIMIT,
			label: "open backlog",
			exclude: epic.number,
		});

		const fs = yield* FileSystem.FileSystem;
		const previous = yield* readManifest(fs, manifestPath(dir));
		const minted = new Set(
			(previous ?? []).filter((record) => record.mintedThisRun).map((record) => record.number),
		);
		const seeded: ReadonlyArray<ChildRecord> = children.value.map((entry) => ({
			number: entry.number,
			id: entry.id,
			title: entry.title,
			type: entry.labels.find((label) => label.startsWith("type:")) ?? null,
			priority: entry.labels.find((label) => /^p\d+$/.test(label)) ?? null,
			readyFor: entry.labels.find((label) => label.startsWith("ready-for:")) ?? null,
			stories: null,
			containment: null,
			linked: true,
			mintedThisRun: minted.has(entry.number),
		}));

		const digest = bodyDigest(epic.body);
		const wrote = yield* writeAll(fs, [
			[
				runJsonPath(dir),
				renderRunRecord({
					epic: epic.number,
					run: ground.run,
					mode,
					cycleDoc,
					bodyDigest: digest,
				}),
			],
			[manifestPath(dir), renderManifest(seeded)],
		]);
		if (wrote !== null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot create the run directory ${dir}: ${wrote} — the run is UNKNOWN.`,
				notes,
			);
		}

		const excluded = yield* registerExclude(fs);
		if (excluded !== null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot register ${EXCLUDE_ENTRY} in this tree's git exclude: ${excluded} — run state could reach the epic's PR.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "opened",
				epic: epic.number,
				run: ground.run,
				mode,
				bodyDigest: digest,
				dir,
				children: children.value.map((entry) => ({
					number: entry.number,
					title: entry.title,
					labels: entry.labels,
				})),
				cycleDoc,
				candidates: {
					outcome: ranked.outcome,
					items: ranked.candidates.map((candidate) => ({
						number: candidate.number,
						title: candidate.title,
						score: candidate.score,
					})),
				},
			}),
			[
				...notes,
				scannedLine(
					VERB,
					children.value.length,
					"existing child",
					`${backlog.value.length} open backlog issue(s) and ${search.value.length} search hit(s) ranked`,
				),
			],
		);
	});

/** The previous attempt's manifest, or `null` when this run has none yet. */
const readManifest = (
	fs: FileSystem.FileSystem,
	path: string,
): Effect.Effect<ReadonlyArray<ChildRecord> | null> =>
	fs.readFileString(path).pipe(
		Effect.map(parseManifest),
		Effect.catchTag("PlatformError", () => Effect.succeed(null)),
	);

/** Write every file, or the first reason one did not land. */
const writeAll = (
	fs: FileSystem.FileSystem,
	files: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<string | null, never, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		for (const [target, text] of files) {
			const failed = yield* fs.makeDirectory(path.dirname(target), {recursive: true}).pipe(
				Effect.andThen(fs.writeFileString(target, text)),
				Effect.as(null),
				Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
			);
			if (failed !== null) return failed;
		}
		return null;
	});

/**
 * Put the run directory behind the tree's own exclude file, so run state can never enter the epic's
 * PR. The file is per-checkout and untracked, so the exclusion never enters a diff and never fights a
 * `--require-clean` check.
 */
const registerExclude = (
	fs: FileSystem.FileSystem,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const tree = yield* readTree;
		if (tree._tag === "Failure") return tree.reason;
		const path = `${tree.value.gitDir}/info/exclude`;
		const current = yield* fs
			.readFileString(path)
			.pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
		if (current.split("\n").some((line) => line.trim() === EXCLUDE_ENTRY)) return null;
		const next = current === "" || current.endsWith("\n") ? current : `${current}\n`;
		return yield* fs.makeDirectory(`${tree.value.gitDir}/info`, {recursive: true}).pipe(
			Effect.andThen(fs.writeFileString(path, `${next}${EXCLUDE_ENTRY}\n`)),
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
	});
