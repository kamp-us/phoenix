/**
 * `heal-ci sweep` — every open PR classified with its strand age, the scheduled surface.
 *
 * **This verb writes nothing.** It files no issue, assigns nobody and spawns nothing: a detector
 * converts a strand into claimable work and normal pull adopts it (ADR 0205, founder ruling #3532).
 *
 * A board report with an unnamed hole in it is the false completeness this verb exists to prevent,
 * so a single unclassifiable PR fails the whole sweep rather than being silently dropped, and a
 * rate limit exhausted mid-scan refuses with nothing partial emitted.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveCi} from "../config/ci-producer.ts";
import {governedRootsOr} from "../config/paths.ts";
import {resolveTargetRepo, scannedLine} from "../ship/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {type Diagnosis, diagnoseOne} from "./diagnose-verb.ts";
import {listOpenPulls, readRateLimit} from "./github.ts";

const VERB = "heal-ci sweep";

/** Enough headroom for one more PR's read set before the limit stops the scan mid-board. */
const RATE_FLOOR = 40;

export interface SweepOptions {
	readonly minAgeMinutes: number;
	readonly limit: number;
	readonly includeAttended: boolean;
	readonly dwellMinutes: number;
	readonly wedgeDwellMinutes: number;
	readonly driftCommits: number;
	readonly repo: string | null;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: number;
}

export const runSweep = (
	options: SweepOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		// Once for the whole board: every PR in this sweep is classified against one root set, and a
		// per-PR read would let the config change mid-sweep and split the answer in two.
		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			'no PR on this board can be classified, and a sweep with a hole in it is never "attended".',
		);
		if (governed._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, governed.message);

		const listed = yield* listOpenPulls(repo);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot list open PRs in ${repo}: ${listed.reason} — the sweep is UNKNOWN, never "none stranded".`,
			);
		}
		if (!listed.value.exhausted) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the open-PR read never reached a terminal page — pagination is unexhausted; refusing to report a partial board.`,
			);
		}
		const open = listed.value.rows;
		if (open.length > options.limit) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: ${open.length} open PRs exceeds --limit ${options.limit} — refusing to answer over a subset; raise the limit.`,
			);
		}

		const ci = yield* resolveCi(options.cwd);
		const notices: string[] = [];
		const found: Diagnosis[] = [];
		let scanned = 0;
		for (const row of open) {
			const limit = yield* readRateLimit();
			if (limit._tag === "Ok" && limit.value.remaining < RATE_FLOOR) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: rate limit exhausted after ${scanned} of ${open.length} PRs, resets at ${limit.value.resetsAt} — refusing a partial board.`,
					notices,
				);
			}
			const result = yield* diagnoseOne(repo, row.number, "", options, governed.roots, ci);
			scanned += 1;
			if (result._tag === "Refused") {
				return refuse(
					result.outcome.code,
					`${VERB}: cannot classify #${row.number}: ${result.outcome.stderr.at(-1) ?? "unreadable"} — refusing a sweep with a hole in it.`,
					notices,
				);
			}
			if (result._tag === "Gone") {
				notices.push(
					`${VERB}: #${row.number} is gone (404) between the list read and its classification — counted as scanned, not stalled.`,
				);
				continue;
			}
			const diagnosis = result.diagnosis;
			if (diagnosis.token === "not-open") {
				notices.push(
					`${VERB}: #${row.number} closed between the list read and its classification — counted as scanned, not stalled.`,
				);
				continue;
			}
			if (diagnosis.ageMinutes < options.minAgeMinutes) continue;
			if (diagnosis.token === "attended" && !options.includeAttended) continue;
			found.push(diagnosis);
		}

		const rows = [...found].sort((a, b) =>
			a.ageMinutes === b.ageMinutes ? a.pr - b.pr : b.ageMinutes - a.ageMinutes,
		);
		const stalled = rows.filter((row) => row.token !== "attended").length;
		notices.push(
			scannedLine(VERB, scanned, "open PR", `${stalled} stranded past ${options.minAgeMinutes}m`),
		);

		return options.json
			? answer(
					JSON.stringify({
						outcome: "swept",
						scanned,
						stalled,
						prs: rows.map((row) => ({
							number: row.pr,
							token: row.token,
							ageMinutes: row.ageMinutes,
							head: row.head,
						})),
					}),
					notices,
				)
			: answer(
					[
						`swept\t${scanned}\t${stalled}`,
						...rows.map((row) => `pr\t${row.pr}\t${row.token}\t${row.ageMinutes}\t${row.head}`),
					].join("\n"),
					notices,
				);
	});
