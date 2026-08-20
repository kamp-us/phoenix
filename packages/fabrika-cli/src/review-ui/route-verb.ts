/**
 * `review-ui route` — the single sanctioned way to resolve the `review-ui` namespace on a PR that
 * renders nothing.
 *
 * `ship scope` raises the `ui` class off a path test, and a path test cannot see whether pixels
 * moved. So a PR whose only `apps/web/src/**` change is a docblock requires a `review-ui` verdict
 * that this group structurally cannot produce — `render` refuses zero surfaces, `post` requires a
 * capture set — and `ship gate` blocks on the absence forever (#6376). This verb records the
 * missing half instead of manufacturing the verdict: an attested, head-bound "nothing here
 * renders", which `ship gate` resolves as `routed` (ADR 0316).
 *
 * **It is not a second verdict path, and three things keep it from becoming one.** The bytes are
 * their own wire format with no polarity, so a route can never be read as a PASS. The record is
 * head-bound with no content binding, so every branch push voids it and the next tree is attested
 * afresh. And `ship gate` admits a route for `review-ui` alone — no other namespace's evidence
 * requirement is reachable from here.
 *
 * The one mechanical precondition is that the PR actually raises the class: routing a namespace the
 * diff never derived resolves nothing and leaves a record claiming a question nobody asked.
 * Deriving it re-uses `review/classes.ts`'s own `isUiSurface` rather than a second predicate — the
 * refusal must bind the exact rule that raised the class, or the two drift and this verb refuses on
 * a PR the gate is meanwhile blocking.
 *
 * Whether the diff renders anything is the *skill's* judgment over `review diff`'s refusal-guarded
 * bytes, and it stays there. No verb decides it: that was candidate 2 on #6376, rejected because a
 * second path heuristic is the first one's defect relocated.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {listPullFiles, patchComment, viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "../review/authored.ts";
import {isUiSurface} from "../review/classes.ts";
import {openPull, resolveTargetRepo, scannedLine} from "../review/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	emit as emitRecord,
	headSha,
	readNamespaced,
	clause as toClause,
} from "../wire/routed-elsewhere.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_TREE,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {NAMESPACE} from "./post-verb.ts";

const VERB = "review-ui route";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the assembled comment",
	emptyMessage: `${VERB}: no body on stdin — a route with no reasoning is an assertion nobody can check; pipe the reasoning in.`,
	bareAtMessage: `${VERB}: the body is a bare "@" path reference — the body never arrived. Send its bytes on stdin.`,
	leakCorrection: "cite it repo-relative or by class root.",
};

export interface RouteOptions {
	readonly pr: number;
	/** The head the emitter read the diff at. The record binds it and nothing else. */
	readonly sha: string;
	/** The one-line why, carried on the record's first line. */
	readonly clause: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

const unreadable = (what: string, pr: number, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot read ${what} for #${pr}: ${reason} — nothing was posted.`,
	);

export const runRoute = (
	options: RouteOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr} = options;
		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
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
				`${VERB}: --clause is blank — a route with no stated reason records nothing a reader can check.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "a route on a closed PR resolves nothing.",
			requireFiles: true,
			emptyReason: "a route over an empty diff resolves nothing (ADR 0092).",
			unknownMessage: (reason) =>
				`${VERB}: cannot read the PR for #${pr}: ${reason} — nothing was posted.`,
		});
		if (target._tag === "Refused") return target.outcome;

		// The record binds the tree the diff was read at, or it is re-read, never re-bound.
		const live = target.pull.headSha;
		if (!prefixMatch(live, inspected)) {
			return refuse(
				STALE_TREE,
				`${VERB}: the live head is ${live}, not ${inspected} — the diff you read is gone; re-read at ${live} (ADR 0058).`,
			);
		}

		const listed = yield* listPullFiles(repo, pr);
		if (listed._tag === "Failure") return unreadable("the changed-file list", pr, listed.reason);
		const declared = target.pull.changedFiles;
		const ui = listed.value.filter(isUiSurface);
		const diagnostics = [
			scannedLine(
				VERB,
				listed.value.length,
				"changed file",
				`${declared} declared; ${ui.length} raise the ui class`,
			),
		];
		// A truncated list can only ever *shrink* the ui count, so the zero-scope refusal below would
		// fire on a PR whose class the gate is meanwhile raising. UNKNOWN, never a derivation.
		if (listed.value.length < declared) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: received ${listed.value.length} of ${declared} changed files — refusing to derive the ui class from a truncated read.`,
				diagnostics,
			);
		}
		if (ui.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${pr}'s diff raises no ui class, so ship gate requires no ${NAMESPACE} namespace — there is nothing to route.`,
				diagnostics,
			);
		}

		const composed = `${emitRecord({namespace: NAMESPACE, sha: inspected, clause})}\n${authored.text.replace(/\n+$/, "")}\n`;
		const leaked = leakRefusal(SURFACE, composed);
		if (leaked !== null) return leaked;

		// One record per namespace, upserted on the emitter's own — a second route at a second head
		// would leave `ship gate` picking between two claims about one question.
		const me = yield* viewerLogin;
		if (me._tag === "Failure") return unreadable("the authenticated user", pr, me.reason);
		const comments = yield* listComments(repo, pr);
		if (comments._tag === "Failure") return unreadable("the comments", pr, comments.reason);
		diagnostics.push(scannedLine(VERB, comments.value.length, "comment"));
		const mine = comments.value
			.filter(
				(comment) =>
					comment.author === me.value && readNamespaced(comment.body, NAMESPACE) !== null,
			)
			.reduce<(typeof comments.value)[number] | undefined>((newest, comment) => {
				if (newest === undefined) return comment;
				const [a, b] = [
					comment.updatedAt === "" ? comment.createdAt : comment.updatedAt,
					newest.updatedAt === "" ? newest.createdAt : newest.updatedAt,
				];
				if (a !== b) return a > b ? comment : newest;
				return comment.id > newest.id ? comment : newest;
			}, undefined);

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
				`${VERB}: create/edit failed: ${failure ?? "unknown"} — UNKNOWN whether the route landed; re-read the PR before retrying.`,
				diagnostics,
			);
		}

		// The write call's own echo is not evidence (#3173).
		const back = yield* getComment(repo, landed.id);
		if (back._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the posted record for #${pr}: ${back.reason} — nothing was proven.`,
				diagnostics,
			);
		}
		const record = readNamespaced(normalizeForReadback(back.value), NAMESPACE);
		const mismatch =
			record === null
				? `the comment does not read back as a ${NAMESPACE} route`
				: record.sha !== inspected
					? `sha ${record.sha}, expected ${inspected}`
					: record.clause !== clause
						? `clause "${record.clause}", expected "${clause}"`
						: normalizeForReadback(back.value) === normalizeForReadback(composed)
							? null
							: "the comment's bytes are not the ones that were sent";
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted, but the read-back does not yield this record (${mismatch}) — inspect comment ${landed.id}.`,
				diagnostics,
			);
		}

		return answer(
			JSON.stringify({
				answer: "routed",
				namespace: NAMESPACE,
				sha: inspected,
				uiFiles: ui.length,
				upsert: mine === undefined ? "created" : "edited",
				commentUrl: landed.url,
			}),
			diagnostics,
		);
	});
