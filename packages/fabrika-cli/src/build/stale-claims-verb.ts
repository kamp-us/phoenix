/**
 * `build claims stale` — every build claim marker on the board that has stood unmoved past a horizon.
 *
 * The sweep counterpart to `build claimants`, which answers one number a caller already suspects.
 * A claim marker outlives the session that posted it, so a driver killed mid-claim strands its issue
 * and nothing anywhere says so: the strandedness was discovered only when somebody happened to try
 * to claim the number and lost on exit `15`. This asks the question nobody could ask before — which
 * numbers are carrying a claim that has not moved — and reports the answer.
 *
 * **It writes nothing and expires nothing.** No marker is edited, deleted or retracted, and a row
 * here is never a finding that a claim is dead: age is the only signal on the board and age alone
 * proves nothing about a session. So the ban on TTLs, leases, steals and eviction-by-inference is
 * untouched — a stranded claim still leaves through `build adopt` then `build release`, which every
 * row's remedy line names. The one place an age test may END a claim is the `spawn-dead` recipe row
 * (`./dead-claim.ts`), and this verb is not it.
 *
 * **The candidate set comes off the search index, and the horizon is what makes that sound.** The
 * open board runs to hundreds of issues and reading every one's comments is hundreds of calls to
 * throw nearly all of them away, so the index narrows to the issues whose comments carry a claim
 * marker at all. An index lags by minutes; a marker this verb reports has stood for the whole
 * horizon, whose floor is a day — so a lag cannot hide a row this verb would print. Every candidate
 * is then read through {@link readClaimants}, the same fold `build claimants` and `lane stale
 * --claims` resolve against, so the three cannot state different facts about one marker.
 *
 * **A read that failed refuses the whole sweep.** A short list of stranded claims is worse than no
 * list: it says an issue is free when nobody looked at it. So an unreadable search, an unreadable
 * thread, an unreadable permission and a marker whose posted instant does not parse are all UNKNOWN
 * on `11`, and none of them is a row quietly dropped.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {searchOpenIssues} from "../io/issues.ts";
import {ageInMinutes} from "../lane/stale.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {readClaimants} from "./claim.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build claims stale";

/** A day. Long enough that a live builder's silence is never a row, since no shell budget reaches it. */
export const DEFAULT_OLDER_THAN_MINUTES = 1440;

/**
 * The index query the candidate set comes from.
 *
 * The quoted keyword is the marker line's own leading word (`BUILD_CLAIM.keyword`), and `in:comments`
 * is what keeps an issue merely *discussing* claims — this verb's own ticket does — out of the set.
 * A candidate that carries no marker after all costs one thread read and contributes no row.
 */
const CANDIDATE_QUERY = ['"build-claim"', "in:comments"] as const;

/** One claim marker that has stood past the horizon, with what a reader needs to act on it. */
interface StrandedRow {
	readonly issue: number;
	readonly title: string;
	readonly commentId: number;
	readonly author: string;
	readonly createdAt: string;
	readonly ageMinutes: number;
	readonly token: string;
	/** The session `build adopt --session` takes when a reader judges that session gone. */
	readonly session: string;
	/**
	 * Whether this is the marker every ownership question on the issue resolves against.
	 *
	 * A lane that raced writes more than one marker, and the whole stack is what `build release`
	 * sweeps — so a non-holder marker is reported rather than hidden, and flagged rather than fused
	 * with the one that actually stands.
	 */
	readonly holder: boolean;
	/** Whether an authorized adopt marker already names this session — succession is under way. */
	readonly adopted: boolean;
}

export interface StaleClaimsOptions {
	readonly olderThanMinutes: number;
	readonly repo: string | null;
	/** The instant ages are measured against, ISO — the adapter's clock, so the verb stays pure. */
	readonly now: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Oldest silence first, then by issue and comment — stable per run. */
const byAge = (left: StrandedRow, right: StrandedRow): number =>
	right.ageMinutes - left.ageMinutes ||
	left.issue - right.issue ||
	left.commentId - right.commentId;

export const runStaleClaims = (
	options: StaleClaimsOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const horizon = options.olderThanMinutes;
		if (!Number.isInteger(horizon) || horizon < 0) {
			return refuse(
				FAILED,
				`${VERB}: --older-than-minutes must be a non-negative whole number of minutes.`,
			);
		}
		const nowEpochMs = Date.parse(options.now);
		if (Number.isNaN(nowEpochMs)) {
			return refuse(FAILED, `${VERB}: "${options.now}" is not an instant to measure ages against.`);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {repo} = resolved;

		const found = yield* searchOpenIssues(repo, [...CANDIDATE_QUERY]);
		if (found._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the issues carrying a claim marker: ${found.reason} — the stranded set is UNKNOWN, never a short list.`,
			);
		}
		const candidates = [...found.value].sort((left, right) => left.number - right.number);

		const rows: StrandedRow[] = [];
		let markers = 0;
		for (const candidate of candidates) {
			const read = yield* readClaimants(repo, candidate.number);
			if (read._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the claim markers on #${candidate.number}: ${read.reason} — the stranded set is UNKNOWN, never a short list.`,
				);
			}
			const adopted = new Set(
				read.adopts.filter((adopt) => adopt.authorized).map((adopt) => adopt.adopted),
			);
			for (const claimant of read.claimants) {
				// An unauthorized marker never wins a race, so it strands nothing and is not a row.
				if (!claimant.authorized) continue;
				markers += 1;
				const postedEpochMs = Date.parse(claimant.createdAt);
				if (Number.isNaN(postedEpochMs)) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: comment ${claimant.commentId} on #${candidate.number} carries ${claimant.token} and "${claimant.createdAt}" is not an instant — its age is UNKNOWN, never inside the horizon.`,
					);
				}
				const age = ageInMinutes(postedEpochMs, nowEpochMs);
				if (age < horizon) continue;
				rows.push({
					issue: candidate.number,
					title: candidate.title,
					commentId: claimant.commentId,
					author: claimant.author,
					createdAt: claimant.createdAt,
					ageMinutes: age,
					token: claimant.token,
					session: claimant.session,
					holder: read.holder?.commentId === claimant.commentId,
					adopted: adopted.has(claimant.session),
				});
			}
		}
		const stranded = [...rows].sort(byAge);
		const scanned = {
			candidates: candidates.length,
			markers,
			olderThanMinutes: horizon,
		};

		const payload = JSON.stringify({
			answer: stranded.length === 0 ? "none" : "stranded",
			now: options.now,
			scanned,
			stranded,
		});
		const scannedLine = `${VERB}: read ${String(candidates.length)} issue(s) the index says carry a claim marker; ${String(markers)} authorized marker(s) on them.`;
		if (stranded.length === 0) {
			return answer(payload, [
				scannedLine,
				`${VERB}: no authorized claim marker has stood unmoved for ${String(horizon)} minute(s).`,
			]);
		}
		const unadopted = stranded.filter((row) => !row.adopted);
		return answer(payload, [
			scannedLine,
			`${VERB}: ${String(stranded.length)} claim marker(s) standing past ${String(horizon)} minute(s): ${stranded
				.map((row) => `#${String(row.issue)} ${row.token} (${String(row.ageMinutes)}m)`)
				.join(", ")}.`,
			...(unadopted.length === 0
				? [`${VERB}: every one of them is already adopted — the lane each adopt names releases it.`]
				: [
						`${VERB}: none of this is a finding that a session is gone. Where you judge one is, the succession is written: fabrika build adopt <n> --session <its session id> --reason "<why>", then fabrika build release <n> --token <the token adopt prints>. Nothing clears a claim on its own.`,
					]),
		]);
	});
