/**
 * `plan verdict` — post the gate's verdict comment, bound to the scope digest, and read it back.
 *
 * **This verb derives its own polarity by re-running the floor.** `--polarity` exists only as a
 * cross-check for an operator driving the verb by hand: when it disagrees with the derived floor the
 * verb refuses on `10` rather than posting either, so the caller's opinion never becomes the posted
 * verdict. A defective floor is not a refusal here — it posts the `FAIL`, which is the deliverable.
 *
 * The verb is the **only** emit path, and it re-reads what it posted: v1 hand-posted a gate verdict at
 * least once and it read as genuine for weeks.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireClaim, requireSession} from "../build/claim.ts";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {createComment, getComment} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {clause, emit, headSha, type Polarity} from "../wire/verdict-marker.ts";
import {CAVEAT_KINDS, type Caveat, readCaveats, renderCaveats} from "./caveats.ts";
import {
	BARE_AT_PATH,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PLAN_MOVED,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import type {Floor} from "./defects.ts";
import {DIGEST_RE} from "./digest.ts";
import {
	deriveFloorFor,
	loadLedger,
	type PlanMessages,
	requireEpic,
	scannedChildren,
} from "./load.ts";
import type {Ledger} from "./model.ts";

const VERB = "plan verdict";

/** The gate's namespace — its own, never `review`'s. A plan verdict wearing a review namespace is
 * the family confusion the partition ruling removed (#4891). */
export const NAMESPACE = "check-epic-plan";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: the ledger grammar refused: ${reason}`,
	zeroChildren: (epic) => `${VERB}: #${epic} has zero children — there is no scope to attest.`,
	notAnEpic: (epic) =>
		`${VERB}: #${epic} is not a type:epic — refusing to post a plan verdict on it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was posted.`,
};

/** The clause is a fixed template, not free prose. */
export const clauseFor = (scanned: number, floor: Floor): string => {
	const body = floor.defects.length === 0 ? "clean" : `${floor.defects.length} defect(s)`;
	const skipped = floor.skipped.length === 0 ? "" : `, ${floor.skipped.length} class(es) skipped`;
	return `${scanned} children scanned, floor ${body}${skipped}`;
};

/**
 * The comment: the marker on the first line, then the scanned set, the derived defects on a `FAIL`,
 * any skipped classes, and the caveats verbatim.
 *
 * `null` when the digest or the clause will not brand — both are impossible for a digest this verb
 * computed, and both are refused rather than papered over, because a marker with an empty field is
 * exactly what the branded slots exist to make unrepresentable.
 */
export const composeVerdict = (
	ledger: Ledger,
	floor: Floor,
	polarity: Polarity,
	caveats: ReadonlyArray<Caveat>,
): string | null => {
	const sha = headSha(ledger.digest);
	const text = clause(clauseFor(ledger.children.length, floor));
	if (sha === null || text === null) return null;
	const sections = [
		emit({namespace: NAMESPACE, polarity, sha, clause: text}).trimEnd(),
		`Scanned: ${ledger.children.map((child) => `#${child.number}`).join(", ")}`,
	];
	if (floor.defects.length > 0) {
		sections.push(
			[
				"## Defects",
				...floor.defects.map(
					(defect) =>
						`- ${defect.type} ${defect.refs.map((ref) => `#${ref}`).join(", ")} — ${defect.detail}`,
				),
			].join("\n"),
		);
	}
	if (floor.skipped.length > 0) {
		sections.push(["## Skipped classes", ...floor.skipped.map((name) => `- ${name}`)].join("\n"));
	}
	if (caveats.length > 0) sections.push(`## Caveats\n\n${renderCaveats(caveats)}`);
	return `${sections.join("\n\n")}\n`;
};

export interface VerdictOptions {
	readonly number: number;
	readonly digest: string;
	readonly polarity: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runVerdict = (
	options: VerdictOptions,
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

		const stdin = yield* options.stdin;
		if (stdin._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable("the caveats on stdin", stdin.reason),
			);
		}
		const authored = stdin._tag === "Text" ? stdin.text : "";

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
		const notes = [
			...held.notes,
			scannedChildren(
				VERB,
				ledger.children.map((child) => child.number),
			),
		];

		const derived = yield* deriveFloorFor(MESSAGES, repo, ledger);
		if (derived._tag === "Refused") return derived.outcome;
		const floor = derived.floor;

		if (ledger.digest !== options.digest) {
			return refuse(
				PLAN_MOVED,
				`${VERB}: the plan moved since the check (digest ${options.digest} → ${ledger.digest}) — re-check before posting.`,
				notes,
			);
		}

		const polarity: Polarity = floor.defects.length === 0 ? "PASS" : "FAIL";
		if (options.polarity !== null && options.polarity.toUpperCase() !== polarity) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --polarity ${options.polarity} disagrees with the derived floor (${polarity}) — a verdict relays the floor, it does not form one.`,
				notes,
			);
		}

		// The bare-@ probe runs ahead of the caveat grammar, unlike the leak scan below: a body that is
		// itself an unexpanded `@path` never arrived at all (#3086), so there is no caveat line to grade
		// and reporting it as an off-vocabulary kind would send the caller looking at the wrong thing.
		if (isBareAtReference(authored)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the authored caveats carry a bare @ path reference — it cannot be redacted.`,
				notes,
			);
		}

		const parsed = readCaveats(authored);
		if (parsed._tag === "OffEnum") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: caveat kind "${parsed.kind}" is not in the closed set (${CAVEAT_KINDS.join(", ")}).`,
				notes,
			);
		}
		if (parsed._tag === "Unparseable") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: "${parsed.line}" is not a caveat line — expected "caveat: <kind> #<ref> — <text>".`,
				notes,
			);
		}
		const scanned = new Set(ledger.children.map((child) => child.number));
		for (const caveat of parsed.caveats) {
			if (scanned.has(caveat.ref)) continue;
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: caveat names #${caveat.ref}, which is not in the scanned set.`,
				notes,
			);
		}

		const leaks = scanBody(authored).leaks;
		if (leaks.length > 0) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the authored caveats carry a machine-local path (${leaks.length} hit(s)).`,
				[...notes, ...renderLeaks(leaks)],
			);
		}

		const body = composeVerdict(ledger, floor, polarity, parsed.caveats);
		if (body === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(
					"the verdict marker",
					`the digest "${ledger.digest}" or the clause will not brand`,
				),
				notes,
			);
		}
		const posted = yield* createComment(repo, options.number, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the write failed: ${posted.reason} — it may or may not have landed; re-read #${options.number} before retrying.`,
				notes,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (back._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the comment posted and could not be re-read — the outcome is UNKNOWN.`,
				notes,
			);
		}
		if (normalizeForReadback(back.value) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the comment posted but does not read back — the verdict needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "posted",
				epic: ledger.epic,
				polarity,
				digest: ledger.digest,
				skipped: floor.skipped,
				comment: posted.value.id,
				caveats: parsed.caveats.length,
			}),
			notes,
		);
	});
