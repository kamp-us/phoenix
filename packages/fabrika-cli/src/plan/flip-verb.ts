/**
 * `plan flip` — flip every `status:planned` child to `status:triaged` and the epic itself to
 * `ready-for:agent`, re-gating first, and report the **observed** result for each.
 *
 * **The epic's audience flip has exactly one owner, and this verb is it.** Under the single-PR model
 * the operator picks the epic up, so the epic's own audience label is load-bearing; the planner must
 * not write it (an ungated plan would become pickable) and the operator must not write it (it would
 * admit itself). The gate is the only place a clean floor has already been proven. It is written
 * last, after every child is *observed* pickable, so the epic never becomes pickable over a
 * half-flipped ledger.
 *
 * Four guards, each designed against a named v1 failure:
 *
 * 1. **Re-gate.** The floor is re-derived and the digest recomputed here, not read off a prior verb's
 *    exit code. The gap between deciding and writing is closed by re-deciding.
 * 2. **Vocabulary precondition.** `POST .../labels` *creates* an unknown label rather than rejecting
 *    it (#4285), so an absent label would be silently minted. With nothing to write the check is
 *    skipped — a `nothing-to-flip` success must not refuse over a label it was never going to touch.
 * 3. **Add before remove, always.** That order is load-bearing, not stylistic: a child caught between
 *    the two calls carries **both** labels, which still satisfies `MISSING_LABEL`'s "a `status:`
 *    prefix" and neither of which is in the digest. Under the reverse order a child between the calls
 *    carries **no** `status:` label, `MISSING_LABEL` flips true, and `plan verdict` would then
 *    re-derive a defective floor on a run the gate believes clean. A failing child never aborts its
 *    siblings.
 * 4. **Re-read every child.** v1 asserted the flip from its pre-mutation intent list and re-read
 *    nothing, so a child left carrying both labels — the ADD landing and the DELETE failing — was
 *    reported as pickable.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireClaim, requireSession} from "../build/claim.ts";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {addLabels, getIssue, listLabels, removeLabel} from "../io/issues.ts";
import {PLANNED, TRIAGED} from "../labels.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	FLOOR_DEFECTIVE,
	LABEL_ABSENT,
	OFF_VOCABULARY,
	PARTIAL_FLIP,
	PLAN_MOVED,
	PRECONDITION_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {DIGEST_RE, FLIP_LABELS} from "./digest.ts";
import {getChild} from "./github.ts";
import {
	deriveFloorFor,
	FAN_OUT,
	loadLedger,
	type PlanMessages,
	requireEpic,
	scannedChildren,
} from "./load.ts";

const VERB = "plan flip";

const AUDIENCE_AGENT = "ready-for:agent";
const AUDIENCE_HUMAN = "ready-for:human";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: the ledger grammar refused during the re-gate: ${reason}`,
	zeroChildren: (epic) =>
		`${VERB}: #${epic} has zero children — refusing to act over zero scope (ADR 0092).`,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to flip its children.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

/** Closed and **total over every child**, not only the ones the flip wrote. */
export type FlipResult = "flipped" | "already" | "unchanged" | "not-planned";

/**
 * The epic's audience result. There is no `not-planned` arm: an epic carrying neither audience label
 * is still owed `ready-for:agent`, so absence is a write, not an exemption.
 */
export type AudienceResult = "flipped" | "already" | "unchanged";

/** The two audience writes the epic is owed, read off its observed labels. */
export const audienceWrites = (
	labels: ReadonlyArray<string>,
): {readonly add: boolean; readonly remove: boolean} => ({
	add: !labels.includes(AUDIENCE_AGENT),
	remove: labels.includes(AUDIENCE_HUMAN),
});

/** The settled epic, decided by the read-back: pickable by agents and by nobody else. */
export const audienceSettled = (observed: ReadonlyArray<string>): boolean =>
	observed.includes(AUDIENCE_AGENT) && !observed.includes(AUDIENCE_HUMAN);

export interface FlipOptions {
	readonly number: number;
	readonly digest: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The observed labels decide the result — never the intent the write was issued with. */
export const classify = (
	before: ReadonlyArray<string>,
	observed: ReadonlyArray<string>,
): FlipResult => {
	if (!before.includes(PLANNED)) return before.includes(TRIAGED) ? "already" : "not-planned";
	return observed.includes(TRIAGED) && !observed.includes(PLANNED) ? "flipped" : "unchanged";
};

export const runFlip = (
	options: FlipOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;
		if (!DIGEST_RE.test(options.digest)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --digest must be 12 lowercase hex — got "${options.digest}".`,
			);
		}

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* requireEpic(MESSAGES, repo, options.number);
		if (target._tag === "Refused") return target.outcome;

		const held = yield* requireClaim(VERB, repo, options.number, session.id);
		if (held._tag === "Refused") return held.outcome;

		const read = yield* loadLedger(MESSAGES, repo, target.issue);
		if (read._tag === "Refused") return read.outcome;
		const ledger = read.ledger;
		const scanned = scannedChildren(
			VERB,
			ledger.children.map((child) => child.number),
		);
		const notes = [...held.notes, scanned];

		const derived = yield* deriveFloorFor(MESSAGES, repo, ledger);
		if (derived._tag === "Refused") return derived.outcome;
		if (derived.floor.defects.length > 0) {
			return refuse(
				FLOOR_DEFECTIVE,
				`${VERB}: the floor is not clean (${derived.floor.defects.length} defect(s)) — refusing to flip.`,
				notes,
			);
		}
		if (ledger.digest !== options.digest) {
			return refuse(
				PLAN_MOVED,
				`${VERB}: the plan moved since the check (digest ${options.digest} → ${ledger.digest}) — re-check before flipping.`,
				notes,
			);
		}

		const planned = ledger.children.filter((child) => child.labels.includes(PLANNED));
		const audience = audienceWrites(target.issue.labels);
		// Only the labels this run would POST are guarded: it is the POST that mints an unknown label,
		// and a DELETE of a label the repo never defined removes nothing.
		const required = [
			...(planned.length > 0 ? FLIP_LABELS : []),
			...(audience.add ? [AUDIENCE_AGENT] : []),
		];
		if (required.length > 0) {
			const labels = yield* listLabels(repo);
			if (labels._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					MESSAGES.unreadable(`${repo}'s label taxonomy`, labels.reason),
					notes,
				);
			}
			for (const label of required) {
				if (labels.value.includes(label)) continue;
				return refuse(
					LABEL_ABSENT,
					`${VERB}: label "${label}" is absent from ${repo}'s taxonomy — refusing to create it (#4285).`,
					notes,
				);
			}
		}

		let writes = 0;
		yield* Effect.forEach(
			planned,
			(child) =>
				Effect.gen(function* () {
					const added = yield* addLabels(repo, child.number, [TRIAGED]);
					if (added._tag === "Ok") writes += 1;
					const removed = yield* removeLabel(repo, child.number, PLANNED);
					if (removed._tag === "Ok") writes += 1;
				}),
			{concurrency: FAN_OUT, discard: true},
		);

		const reread = yield* Effect.forEach(
			ledger.children,
			(child) => getChild(repo, child.number).pipe(Effect.map((found) => [child, found] as const)),
			{concurrency: FAN_OUT},
		);

		const rows: {number: number; observed: ReadonlyArray<string>; result: FlipResult}[] = [];
		for (const [child, found] of reread) {
			if (found._tag !== "Present") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: wrote ${writes} label change(s) and could not re-read child #${child.number} — the outcome is UNKNOWN.`,
					notes,
				);
			}
			const observed = [...found.value.labels].sort();
			rows.push({number: child.number, observed, result: classify(child.labels, observed)});
		}

		const unchanged = rows.filter((row) => row.result === "unchanged");
		if (unchanged.length > 0) {
			const flipped = rows.filter((row) => row.result === "flipped").length;
			return refuse(
				PARTIAL_FLIP,
				`${VERB}: ${flipped} of ${rows.length} children flipped; ${unchanged.length} unchanged (${unchanged
					.map((row) => `#${row.number}`)
					.join(", ")}) — the epic is half-flipped and needs a human.`,
				notes,
			);
		}

		let audienceResult: AudienceResult = "already";
		let audienceObserved = [...target.issue.labels].sort();
		if (audience.add || audience.remove) {
			if (audience.add) {
				const added = yield* addLabels(repo, ledger.epic, [AUDIENCE_AGENT]);
				if (added._tag === "Ok") writes += 1;
			}
			if (audience.remove) {
				const removed = yield* removeLabel(repo, ledger.epic, AUDIENCE_HUMAN);
				if (removed._tag === "Ok") writes += 1;
			}
			const reread = yield* getIssue(repo, ledger.epic);
			if (reread._tag !== "Present") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: wrote ${writes} label change(s) and could not re-read the epic #${ledger.epic} — the outcome is UNKNOWN.`,
					notes,
				);
			}
			audienceObserved = [...reread.value.labels].sort();
			audienceResult = audienceSettled(audienceObserved) ? "flipped" : "unchanged";
			if (audienceResult === "unchanged") {
				return refuse(
					PARTIAL_FLIP,
					`${VERB}: every child flipped but epic #${ledger.epic} does not carry ${AUDIENCE_AGENT} alone — the epic is half-flipped and needs a human.`,
					notes,
				);
			}
		}

		const flipped = rows.filter((row) => row.result === "flipped").length;
		const already = rows.filter((row) => row.result === "already").length;
		const nothingToFlip = planned.length === 0 && audienceResult === "already";
		return answer(
			JSON.stringify({
				answer: "flipped",
				epic: ledger.epic,
				digest: ledger.digest,
				terminal: nothingToFlip ? "nothing-to-flip" : "flipped-all",
				children: rows,
				flipped,
				already,
				audience: {result: audienceResult, observed: audienceObserved},
			}),
			notes,
		);
	});
