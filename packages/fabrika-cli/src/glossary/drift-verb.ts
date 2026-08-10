/**
 * `glossary drift` — the surfaces that moved since a register last changed, and the candidate
 * coinages in them.
 *
 * **The three outcomes are disjoint by construction, and all three exit 0.** `bootstrap` is reachable
 * only from a directory that was *read* and holds no register (or one with zero rows); `clean` means
 * the range was computed and every candidate was suppressed; `drift` means one survived. A `--dir`
 * that could not be read is `11`, and a `--paths` matching nothing is `7` — answering `clean` there
 * is exactly how v1 reported "no drift" forever against a layout the repo did not have (#4776).
 *
 * This verb reports; it never reds a merge (ADR 0128).
 */

import type {FileSystem} from "effect";
import {Effect, Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type Candidate, rankCandidates} from "./candidates.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {readRegister, registerFilesIn, resolveDir, selectRegisters} from "./guards.ts";
import {commitsSince, filesChangedBy, lastCommitTouching, trackedFiles} from "./history.ts";
import type {Row} from "./register.ts";

const VERB = "glossary drift";

export interface DriftOptions {
	readonly register: string;
	readonly dir: string;
	/** Comma-separated pathspecs; empty means the whole tree, never a fixed layout. */
	readonly paths: string;
	readonly limit: number;
	readonly json: boolean;
	readonly cwd: string;
}

/** This verb reads disk and shells out, so it needs both platform seams. */
type DriftEffect<A> = Effect.Effect<
	A,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

const messages = {
	unreadable: (path: string, reason: string) =>
		`${VERB}: cannot read ${path}: ${reason} — the declared set is UNKNOWN, never "0 declared".`,
	malformed: (path: string, _reason: string) =>
		`${VERB}: ${path} has no parseable term table — the declared set is UNKNOWN.`,
};

interface Live {
	readonly display: string;
	readonly path: string;
	readonly rows: ReadonlyArray<Row>;
}

export const runDrift = (options: DriftOptions): DriftEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const selected = selectRegisters(VERB, options.register, {allowed: true, refusal: ""});
		if (selected._tag === "Refused") return selected.outcome;

		const dir = yield* resolveDir(VERB, options.cwd, options.dir);
		if (dir._tag === "Refused") return dir.outcome;
		const files = registerFilesIn(dir.value, selected.value, yield* Path.Path);

		const live: Live[] = [];
		let bootstrapReason: string | null = null;
		for (const file of files) {
			const state = yield* readRegister(file, messages);
			if (state._tag === "Refused") return state.outcome;
			if (state.value._tag === "Absent") {
				bootstrapReason ??= `no register at ${file.display} — this repo has not adopted one yet, which is bootstrap, not empty drift`;
				continue;
			}
			if (state.value.parsed.rows.length === 0) {
				bootstrapReason ??= `the register at ${file.display} parsed to 0 rows — bootstrap, not empty drift`;
				continue;
			}
			live.push({display: file.display, path: file.path, rows: state.value.parsed.rows});
		}

		if (live.length === 0) {
			const reason =
				bootstrapReason ??
				`no register at ${dir.value.display} — this repo has not adopted one yet, which is bootstrap, not empty drift`;
			return emit(
				{outcome: "bootstrap", candidates: [], reason, sinceCommit: null, scannedCommits: 0},
				0,
				options.json,
				[`${VERB}: ${reason}.`],
			);
		}

		const declared = new Set(live.flatMap((register) => register.rows.map((row) => row.key)));

		const pathspecs = options.paths
			.split(",")
			.map((spec) => spec.trim())
			.filter((spec) => spec !== "");
		if (pathspecs.length > 0) {
			const tracked = yield* trackedFiles(pathspecs);
			if (tracked._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot list the tracked files matching --paths ${options.paths}: ${tracked.reason} — the range is UNKNOWN.`,
				);
			}
			if (tracked.value.length === 0) {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: --paths ${options.paths} matched 0 tracked files — refusing to report a clean sweep of nothing (ADR 0092).`,
				);
			}
		}

		// With two registers the range starts at the OLDER of their last changes, so nothing that moved
		// since either one last changed falls outside the sweep — this list is recall-biased by design.
		let since: {sha: string; when: number} | null = null;
		for (const register of live) {
			const stamp = yield* lastCommitTouching(register.path);
			if (stamp._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot resolve the commit that last changed ${register.display}: ${stamp.reason} — the range is UNKNOWN, never "never committed".`,
				);
			}
			if (since === null || stamp.value.when < since.when) since = stamp.value;
		}
		const sinceCommit = (since as {sha: string; when: number}).sha;

		const commits = yield* commitsSince(sinceCommit, pathspecs);
		if (commits._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the commit range ${sinceCommit}..HEAD: ${commits.reason} — the range is UNKNOWN.`,
			);
		}

		const scope = `${VERB}: swept ${commits.value.length} commit(s) since ${sinceCommit} against ${declared.size} declared key(s).`;
		const ranked = rankCandidates(commits.value, declared, options.limit);
		if (ranked.length === 0) {
			const reason = `swept ${commits.value.length} commit(s) since ${sinceCommit}; every candidate was already declared — this is a clean sweep, not an unread range`;
			return emit(
				{
					outcome: "clean",
					candidates: [],
					reason,
					sinceCommit,
					scannedCommits: commits.value.length,
				},
				declared.size,
				options.json,
				[scope, `${VERB}: ${reason}.`],
			);
		}

		const surfaces: {phrase: string; hits: number; firstSurface: string}[] = [];
		const cache = new Map<string, string>();
		for (const candidate of ranked) {
			surfaces.push({
				phrase: candidate.phrase,
				hits: candidate.hits,
				firstSurface: yield* firstSurfaceOf(candidate, cache),
			});
		}
		return emit(
			{
				outcome: "drift",
				candidates: surfaces,
				reason: null,
				sinceCommit,
				scannedCommits: commits.value.length,
			},
			declared.size,
			options.json,
			[scope],
		);
	});

/** The first file the earliest contributing commit changed. An unreadable commit reports `-`. */
const firstSurfaceOf = (candidate: Candidate, cache: Map<string, string>): DriftEffect<string> =>
	Effect.gen(function* () {
		const known = cache.get(candidate.firstCommit);
		if (known !== undefined) return known;
		const changed = yield* filesChangedBy(candidate.firstCommit);
		const surface = changed._tag === "Failure" ? "-" : (changed.value[0] ?? "-");
		cache.set(candidate.firstCommit, surface);
		return surface;
	});

interface DriftResult {
	readonly outcome: string;
	readonly candidates: ReadonlyArray<{
		readonly phrase: string;
		readonly hits: number;
		readonly firstSurface: string;
	}>;
	readonly reason: string | null;
	readonly sinceCommit: string | null;
	readonly scannedCommits: number;
}

const emit = (
	result: DriftResult,
	declaredKeys: number,
	json: boolean,
	diagnostics: ReadonlyArray<string>,
): VerbOutcome =>
	json
		? answer(JSON.stringify({...result, declaredKeys}), diagnostics)
		: answer(
				[
					result.outcome,
					...result.candidates.map(
						(candidate) => `${candidate.phrase}\t${candidate.hits}\t${candidate.firstSurface}`,
					),
				].join("\n"),
				diagnostics,
			);
