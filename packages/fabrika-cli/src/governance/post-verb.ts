/**
 * `governance post` — the single sanctioned emit of the `governance` namespace verdict.
 *
 * Six steps, each gating the next: re-resolve the live head, re-derive the namespace requirement at
 * the bound commit, compose the first line through the `verdict-marker` wire format, leak-scan the
 * assembled comment, upsert one comment, and read it back unconditionally from live PR state.
 *
 * **The namespace is fixed.** There is no `--namespace` flag: this verb emits exactly one namespace,
 * so it cannot be aimed anywhere else even by a confused caller. That is the disjointness guarantee
 * made structural from the opposite direction to `review post`, which refuses a namespace outside its
 * derived set.
 *
 * **There is no advisory carrier.** §CP is not this namespace's question, the governance verdict is
 * never the §CP approval, and a carrier flag here would be a second §CP answer wearing an input's
 * clothes.
 *
 * The `14` refusal is the fail-closed condition's write-seam half: absence of a verdict on a required
 * diff is a refusal downstream, presence of one on a non-required diff is a refusal here. Both
 * directions exist so the namespace means exactly one thing.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {diffRangePaths} from "../io/git.ts";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {patchComment, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {GOVERNANCE_ROOTS, touchesGovernanceRoot} from "../review/classes.ts";
import {contentDigestAt} from "../review/content-binding.ts";
import {badNumber, openPull, resolveTargetRepo, scannedLine} from "../review/target.ts";
import {latestByWriteRecency} from "../review/write-recency.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	contentDigest,
	emit as emitMarker,
	headSha,
	type Polarity,
	read as readMarker,
	clause as toClause,
} from "../wire/verdict-marker.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {
	NOT_HARNESS_TOUCHING,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {bindGovernanceHead, boundLine} from "./head.ts";

const VERB = "governance post";

/** The one namespace this verb emits. Not a flag, and not derivable from anything a caller passes. */
export const NAMESPACE = "governance";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the assembled comment",
	emptyMessage: `${VERB}: no body on stdin — an empty verdict reads as UNGATED; pipe the verdict body in.`,
	bareAtMessage: `${VERB}: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.`,
	leakCorrection: "cite it repo-relative or by class root.",
};

export interface PostOptions {
	readonly pr: number;
	readonly polarity: string;
	readonly sha: string;
	readonly clause: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** Whether a comment already carries this namespace's marker — the upsert's match key. */
const carriesNamespace = (body: string): boolean => {
	const parsed = readMarker(body);
	return parsed._tag === "Found" && parsed.value.namespace === NAMESPACE;
};

/**
 * Why the read-back does not show what was posted, or `null` when it does.
 *
 * Two assertions, and both are needed. The marker goes through the format's own `read`, so the four
 * fields have to be the four that were composed; the whole comment is then compared through
 * `normalizeForReadback` — a marker that parses proves nothing about the body under it, and the body
 * is the verdict. That normalizer is imported rather than re-derived because its trailing-newline step
 * is the one a re-derivation drops, and dropping it fires this refusal on every clean run.
 */
const mismatchOf = (
	body: string,
	posted: {
		readonly polarity: string;
		readonly sha: string;
		readonly content: string;
		readonly clause: string;
	},
	composed: string,
): string | null => {
	const normalized = normalizeForReadback(body);
	const parsed = readMarker(normalized);
	if (parsed._tag !== "Found") return parsed.reason;
	const marker = parsed.value;
	if (marker.namespace !== NAMESPACE) return `namespace ${marker.namespace}, expected ${NAMESPACE}`;
	if (marker.polarity !== posted.polarity) {
		return `polarity ${marker.polarity}, expected ${posted.polarity}`;
	}
	if (marker.sha !== posted.sha) return `sha ${marker.sha}, expected ${posted.sha}`;
	if (marker.content !== posted.content) {
		return `content ${marker.content ?? "none"}, expected ${posted.content}`;
	}
	if (marker.clause !== posted.clause) {
		return `clause "${marker.clause}", expected "${posted.clause}"`;
	}
	return normalized === normalizeForReadback(composed)
		? null
		: "the comment's bytes are not the ones that were sent";
};

const unreadable = (what: string, pr: number, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot read ${what} for #${pr}: ${reason} — nothing was posted.`,
	);

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
		const inspected = headSha(options.sha);
		if (inspected === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --sha "${options.sha}" is not a head SHA — expected 7–40 lowercase hex characters.`,
			);
		}
		const clause = toClause(options.clause);
		if (clause === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --clause is blank — a verdict with no clause states nothing.`,
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
			unknownMessage: (reason) =>
				`${VERB}: cannot read the PR for #${pr}: ${reason} — nothing was posted.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const live = target.pull.headSha;

		// Step 1 — the verdict binds the tree it was formed over, or it is re-reviewed, never re-bound.
		if (!prefixMatch(live, inspected)) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${live}, not ${inspected} — the tree you judged is gone; re-review at ${live} (ADR 0058).`,
			);
		}

		// Step 2 — re-derive the requirement at the bound commit. The head check labels the tree; only
		// the binding makes the derived answer provably that tree's (#5122).
		const bound = yield* bindGovernanceHead(
			VERB,
			"the file list cannot be bound to a commit, so the derivation is UNKNOWN.",
			repo,
			pr,
			target.pull,
			options.sha,
		);
		if (bound._tag === "Refused") return bound.outcome;
		const head = bound.head;
		const listed = yield* diffRangePaths(head.base, head.sha);
		if (listed._tag === "Failure") return unreadable("the changed-file list", pr, listed.reason);
		// Taken at the SAME bound commit the requirement is re-derived at — see `review/post-verb.ts`.
		const content = yield* contentDigestAt(head.base, head.sha);
		if (content._tag === "Failure") return unreadable("the content digest", pr, content.reason);
		const diagnostics = [
			boundLine(VERB, head),
			scannedLine(VERB, listed.value.length, "changed file"),
			`${VERB}: content ${content.value} — the digest of ${head.base}...${head.sha} this verdict survives on (ADR 0276).`,
		];
		if (!touchesGovernanceRoot(listed.value)) {
			return refuse(
				NOT_HARNESS_TOUCHING,
				`${VERB}: #${pr}'s diff touches no governance root (${GOVERNANCE_ROOTS.join(", ")}) — the namespace is not required here, and a verdict in it would attest a scope nobody derived.`,
				diagnostics,
			);
		}

		// Step 3 — compose through the wire format, never by hand (#3173).
		const composed = `${emitMarker({
			namespace: NAMESPACE,
			polarity: polarity as Polarity,
			sha: inspected,
			content: contentDigest(content.value),
			clause,
		})}\n${authored.text}`;

		// Step 4 — the scan runs over the ASSEMBLED comment, so nothing this verb appended escapes it.
		const leaked = leakRefusal(SURFACE, composed);
		if (leaked !== null) return leaked;

		// Step 5 — one namespace, one comment: a second marker stacked on line 2 is un-anchored,
		// resolves the namespace empty, and fail-closes a substantively-passing PR.
		const me = yield* viewerLogin;
		if (me._tag === "Failure") return unreadable("the authenticated user", pr, me.reason);
		const comments = yield* listComments(repo, pr);
		if (comments._tag === "Failure") return unreadable("the comments", pr, comments.reason);
		// The NEWEST match, by write recency — the same end of the order a resolver reads from. The list
		// arrives oldest-first, so taking the first match edits the comment least likely to be in force
		// and the edit lands where nobody reads (#5048).
		const mine = latestByWriteRecency(
			comments.value.filter(
				(comment) => comment.author === me.value && carriesNamespace(comment.body),
			),
		);

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
				`${VERB}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the verdict landed; re-read #${pr}'s comments before retrying.`,
				diagnostics,
			);
		}
		const upsert = mine === undefined ? "created" : "edited";

		// Step 6 — read it back from live state. The write call's own echo is not evidence (#3173).
		const back = yield* getComment(repo, landed.id);
		const mismatch =
			back._tag === "Failure"
				? back.reason
				: mismatchOf(
						back.value,
						{polarity, sha: inspected, content: content.value, clause},
						composed,
					);
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
						namespace: NAMESPACE,
						polarity,
						sha: inspected,
						content: content.value,
						upsert,
						commentUrl: landed.url,
					}),
					diagnostics,
				)
			: answer(
					`posted\t${NAMESPACE}\t${polarity}\t${inspected}\t${content.value}\t${upsert}\t${landed.url}`,
					diagnostics,
				);
	});
