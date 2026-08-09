/**
 * `review post` — the single sanctioned verdict emit.
 *
 * Six steps, each gating the next: recompute the class set, re-resolve the live head, compose the
 * first line through the wire format's `emit`, leak-scan the assembled comment, upsert **one comment
 * per namespace**, and read it back unconditionally from live PR state.
 *
 * Every one of those is a scar. #3173's hand-rolled `gh api` emit posted a literal path and
 * self-reported a false PASS, which is why the read-back re-fetches instead of trusting a carried
 * variable. The namespace set is recomputed rather than trusted because v1 got "a gate never emits
 * another gate's marker" free from one-skill-per-namespace and this owner does not. The `12` refusal
 * is `bindToHead`'s `Stale` arm applied at the write seam, where its absence costs the most. And the
 * marker is the comment's **literal first line** — a second marker stacked on line 2 is un-anchored,
 * resolves its namespace empty, and fail-closes a substantively-passing PR (the PR #2456 stall).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {listPullFiles, patchComment, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	emit as emitMarker,
	headSha,
	type Polarity,
	read as readMarker,
	clause as toClause,
} from "../wire/verdict-marker.ts";
import {emitAdvisory, readAdvisory, reviewedHeadLine} from "./advisory.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {namespacesOf, partition} from "./classes.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "review post";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the assembled comment",
	emptyMessage: `${VERB}: no body on stdin — an empty verdict reads as UNGATED; pipe the verdict body in.`,
	bareAtMessage: `${VERB}: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.`,
	leakCorrection: "cite it repo-relative or by class root.",
};

export type Carrier = "marker" | "advisory";

export interface PostOptions {
	readonly pr: number;
	readonly namespace: string;
	readonly polarity: string;
	readonly sha: string;
	readonly clause: string;
	readonly carrier: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

interface Posted {
	readonly namespace: string;
	readonly polarity: string;
	readonly sha: string;
	readonly clause: string;
}

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * Why the read-back does not show what was posted, or `null` when it does.
 *
 * The marker carrier is checked through the format's own `read`, which is the contract's step 6. The
 * **advisory** carrier cannot be: its first line deliberately withholds the SHA, so the format reads
 * it as `Malformed` by design (ADR 0111). It is verified through its own two anchors instead — the
 * advisory first line and the canonical `Reviewed-head:` body line — which is the same unconditional
 * live-state assertion applied to the shape that was actually written.
 */
const mismatchOf = (body: string, posted: Posted, carrier: Carrier): string | null => {
	const normalized = normalizeForReadback(body);
	if (carrier === "advisory") {
		const advisory = readAdvisory(normalized);
		if (advisory === null) return "the advisory first line or its Reviewed-head: line is not there";
		if (advisory.namespace !== posted.namespace) {
			return `namespace ${advisory.namespace}, expected ${posted.namespace}`;
		}
		return advisory.sha === posted.sha
			? null
			: `Reviewed-head ${advisory.sha}, expected ${posted.sha}`;
	}
	const parsed = readMarker(normalized);
	if (parsed._tag !== "Found") return parsed.reason;
	const marker = parsed.value;
	if (marker.namespace !== posted.namespace) {
		return `namespace ${marker.namespace}, expected ${posted.namespace}`;
	}
	if (marker.polarity !== posted.polarity) {
		return `polarity ${marker.polarity}, expected ${posted.polarity}`;
	}
	if (marker.sha !== posted.sha) return `sha ${marker.sha}, expected ${posted.sha}`;
	return normalizeForReadback(marker.clause) === normalizeForReadback(posted.clause)
		? null
		: `clause "${marker.clause}", expected "${posted.clause}"`;
};

/** Steps 1, 2 and 5's reads failing is `11`: nothing was written, so the outcome is known-unwritten. */
const unreadableMessage = (what: string, pr: number, reason: string): string =>
	`${VERB}: cannot read ${what} for #${pr}: ${reason} — nothing was posted.`;

const unreadable = (what: string, pr: number, reason: string): VerbOutcome =>
	refuse(PRECONDITION_UNKNOWN, unreadableMessage(what, pr, reason));

export const runPost = (
	options: PostOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;

		const polarity = options.polarity.toUpperCase();
		if (polarity !== "PASS" && polarity !== "FAIL") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --polarity must be PASS or FAIL — got "${options.polarity}". A third token is not a polarity.`,
			);
		}
		const carrier = options.carrier.toLowerCase();
		if (carrier !== "marker" && carrier !== "advisory") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --carrier must be marker or advisory — got "${options.carrier}".`,
			);
		}
		if (carrier === "advisory" && polarity === "FAIL") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --carrier advisory is a PASS path only (ADR 0226) — post the FAIL marker instead.`,
			);
		}
		const inspected = headSha(options.sha);
		if (inspected === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --sha "${options.sha}" is not a head SHA — expected 7–40 hex characters.`,
			);
		}
		const clause = toClause(options.clause);
		if (clause === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --clause is blank — a verdict with no clause says nothing to a human.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "a verdict on a closed PR gates nothing.",
			requireFiles: false,
			unknownMessage: (reason) => unreadableMessage("the PR", pr, reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const live = target.pull.headSha;

		// Step 1 — recompute the class set this run derived, and refuse a namespace outside it.
		const listed = yield* listPullFiles(repo, pr);
		if (listed._tag === "Failure") return unreadable("the changed-file list", pr, listed.reason);
		const derived = namespacesOf(partition(listed.value));
		const diagnostics = [scannedLine(VERB, listed.value.length, "changed file")];
		const namespace = options.namespace.trim().toLowerCase();
		if (!derived.includes(namespace)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --namespace ${namespace} is not derived by #${pr}'s diff (present: ${derived.join(", ")}) — a gate never emits a namespace it did not judge.`,
				diagnostics,
			);
		}

		// Step 2 — the verdict binds the tree it was formed over, or it is re-reviewed, never re-bound.
		if (!prefixMatch(live, inspected)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${live}, not ${inspected} — the tree you judged is gone; re-review at ${live} (ADR 0058).`,
				diagnostics,
			);
		}

		// Step 3 — compose through the wire format, or through the ADR 0151 advisory shape.
		const firstLine =
			carrier === "advisory"
				? emitAdvisory(namespace, clause)
				: emitMarker({namespace, polarity: polarity as Polarity, sha: inspected, clause});
		const below =
			carrier === "advisory" ? `${reviewedHeadLine(inspected)}\n\n${authored.text}` : authored.text;
		const composed = `${firstLine}\n${below}`;

		// Step 4 — the scan runs over the ASSEMBLED comment, so nothing this verb appended escapes it.
		const leaked = leakRefusal(SURFACE, composed);
		if (leaked !== null) return leaked;

		// Step 5 — one namespace, one comment: edit this namespace's own comment, else create one.
		const me = yield* viewerLogin;
		if (me._tag === "Failure") return unreadable("the authenticated user", pr, me.reason);
		const comments = yield* listComments(repo, pr);
		if (comments._tag === "Failure") return unreadable("the comments", pr, comments.reason);
		const mine = comments.value.find((comment) => {
			if (comment.author !== me.value) return false;
			const parsed = readMarker(comment.body);
			return parsed._tag === "Found" && parsed.value.namespace === namespace;
		});

		let landed: {readonly id: number; readonly url: string} | null = null;
		let failure: string | null = null;
		if (mine === undefined) {
			const created = yield* createComment(repo, pr, composed);
			if (created._tag === "Failure") failure = created.reason;
			else landed = {id: created.value.id, url: created.value.url};
		} else {
			const edited = yield* patchComment(repo, mine.id, composed);
			if (edited._tag === "Failure") failure = edited.reason;
			else landed = {id: mine.id, url: edited.value};
		}
		if (landed === null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the verdict landed; run \`fabrika review verdicts ${pr}\` before retrying.`,
				diagnostics,
			);
		}
		const upsert = mine === undefined ? "created" : "edited";

		// Step 6 — read it back from live state. The write call's own echo is not evidence (#3173).
		const back = yield* getComment(repo, landed.id);
		const mismatch =
			back._tag === "Failure"
				? back.reason
				: mismatchOf(back.value, {namespace, polarity, sha: inspected, clause}, carrier);
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted, but the read-back does not yield this marker (${mismatch}) — the PR may carry a garbled verdict; inspect comment ${landed.id}.`,
				diagnostics,
			);
		}

		return json
			? answer(
					JSON.stringify({
						outcome: "posted",
						namespace,
						polarity,
						sha: inspected,
						upsert,
						carrier,
						commentUrl: landed.url,
					}),
					diagnostics,
				)
			: answer(
					`posted\t${namespace}\t${polarity}\t${inspected}\t${upsert}\t${landed.url}`,
					diagnostics,
				);
	});
