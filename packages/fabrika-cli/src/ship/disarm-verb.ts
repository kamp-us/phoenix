/**
 * `ship disarm` — the four-site merge-intent lifecycle (ADR 0198), read-back-verified.
 *
 * **Fail-closed at every indeterminate probe, and the direction is chosen per probe:** an unreadable
 * armed-state reads *armed* (clearing a never-armed intent is a no-op; leaving a parked one is an
 * ungated enqueue — #3700's one-second window), and an unreadable queue regime reads
 * *queue-governed* (so a failed read cannot grant the pre-queue keep). The regime is the **base
 * branch's**, never this PR's queue history: a per-PR proxy exempts exactly the parked intent this
 * verb exists to clear.
 *
 * A `disarmed` answer is proven by re-reading `auto_merge` after the write. The disable call's own
 * exit status fuses "it failed" with "nothing was armed" and is never trusted.
 *
 * **There is no `7` seat.** A disarm aimed at a merged or absent PR answers `kept` with the reason —
 * the intent is structurally moot, which is a proven answer. Refusing would make the safety verb the
 * fragile one on exactly the cleanup paths that need it.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullRequest} from "../io/pulls.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {disableAutoMerge, isQueueGoverned, pullTimeline} from "./github.ts";
import {queueStateOf} from "./queue.ts";
import {badNumber, resolveTargetRepo} from "./target.ts";

const VERB = "ship disarm";

/** The four ADR 0198 lifecycle sites. The policy differs per site; the vocabulary does not. */
export const SITES = ["preflight", "refuse", "post-enqueue", "ejected"] as const;
export type Site = (typeof SITES)[number];

export type KeptReason = "merged" | "live-queued" | "not-armed" | "pre-queue-regime";

export interface DisarmOptions {
	readonly pr: number;
	readonly site: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runDisarm = (
	options: DisarmOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json, site} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		if (!SITES.includes(site as Site)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --site ${site} is not a lifecycle site (${SITES.join(", ")}).`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const emit = (outcome: "kept" | "disarmed", reason: string): VerbOutcome =>
			json
				? answer(JSON.stringify({outcome, site, reason}))
				: answer(`disarm\t${outcome}\t${site}\t${reason}`);

		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${pr}'s merge state: ${found.reason} — whether an intent is armed is UNKNOWN.`,
			);
		}
		// A PR that is gone carries no intent — structurally moot, which is an answer.
		if (found._tag === "Absent") return emit("kept", "merged");
		const pull = found.value;
		if (pull.merged) return emit("kept", "merged");

		const events = yield* pullTimeline(repo, pr);
		// The `live-queued` keep rests on a POSITIVE reading, so it needs the pagination proof too: an
		// unexhausted read is treated exactly like an unreadable one, never as evidence of a state.
		if (
			events._tag === "Ok" &&
			events.value.exhausted &&
			queueStateOf(events.value.events) === "queued"
		) {
			return emit("kept", "live-queued");
		}

		if (site === "post-enqueue") {
			const governed = yield* isQueueGoverned(repo, pull.baseRef);
			if (governed._tag === "Ok" && !governed.value) {
				// Off a queue, `--auto` IS the merge mechanism — clearing it here would un-ship the PR.
				return emit("kept", "pre-queue-regime");
			}
		}

		if (!pull.autoMerge) return emit("kept", "not-armed");

		const cleared = yield* disableAutoMerge(repo, pr);
		const after = yield* getPullRequest(repo, pr);
		if (after._tag !== "Present" || after.value.autoMerge) {
			const why =
				after._tag === "Unknown"
					? after.reason
					: after._tag === "Absent"
						? "the PR is no longer readable"
						: cleared._tag === "Failure"
							? cleared.reason
							: "auto_merge is still set";
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: disarm attempted, re-read cannot confirm clear: ${why} — report "merge intent: NOT cleared".`,
			);
		}
		return emit("disarmed", "cleared");
	});
