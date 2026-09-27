/**
 * `build takeover` — hand a pull request another author opened to the pipeline, on a trusted
 * account's dated say-so.
 *
 * A pull request belongs to its author (`../ownership/`): `build` will not repair it, `ship` will not
 * land it and `heal-ci` routes it back to its author. This verb is the "take over #N" path — it posts
 * one comment whose first line is the `takeover-granted` marker and whose body quotes the dated
 * authorization, and from then on every reader counts the PR as the pipeline's.
 *
 * The clauses are conjunctive, and they are the reader's own clauses run before the write, so a
 * grant this verb posts is one the reader honours: the invoking account is in the repo's control-plane
 * set (the owners `.github/CODEOWNERS` names on the default branch), holds `write+`, and is not the PR's author, and the authorization is
 * present and dated. A PR that is already the pipeline's is not re-granted — one of ours needs no
 * grant, and a PR already handed over answers with the grant that stands.
 *
 * **What `granted` proves, exactly.** That a control-plane account posted a marker naming this PR over a
 * dated authorization. It does not prove the quote is a truthful record of what was said; in a repo
 * where agents run on a granting account's own token, the agent's restraint is what holds — the same
 * residue `build clear` carries.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9844#issuecomment-5851228368
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, listComments} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {sameLogin} from "../ownership/pr-ownership.ts";
import {readPrOwnership} from "../ownership/read.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {stampOf} from "../wire/grill-marker.ts";
import * as takeoverGrant from "../wire/takeover-grant.ts";
import type {DocumentRead} from "./clear-verb.ts";
import {
	capClearAuthorsNotices,
	clearsWriteFloor,
	controlPlaneMembership,
	permissionsFor,
} from "./clearances.ts";
import {
	AUTHORIZATION_VOID,
	BARE_AT_PATH,
	GRANT_UNAUTHORIZED,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {openPull, resolveTargetRepo} from "./target.ts";

const VERB = "build takeover";

/** Any ISO-8601 date in the quote — a grant the reader cannot place in time is not dated. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

export interface TakeoverOptions<R = never> {
	readonly pr: number;
	/** The `--authorization` path, carried for the refusal messages only. */
	readonly authorizationPath: string;
	readonly authorization: Effect.Effect<DocumentRead, never, R>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runTakeover = <R = never>(
	options: TakeoverOptions<R>,
): Effect.Effect<VerbOutcome, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, authorizationPath} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const read = yield* options.authorization;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`${VERB}: could not read --authorization ${authorizationPath}: ${read.reason} — the authorization is UNKNOWN, never empty.`,
			);
		}
		const quoted = read.text.trim();
		if (quoted === "") {
			return refuse(
				AUTHORIZATION_VOID,
				`${VERB}: --authorization ${authorizationPath} is empty — a grant with no quoted authorization is void.`,
			);
		}
		if (!ISO_DATE.test(quoted)) {
			return refuse(
				AUTHORIZATION_VOID,
				`${VERB}: --authorization ${authorizationPath} carries no ISO-8601 date — the authorization must be dated.`,
			);
		}
		if (isBareAtReference(quoted)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the authorization is a bare @ path reference — not redactable, refusing to post it.`,
			);
		}
		const leaks = scanBody(quoted);
		const firstLeak = leaks.leaks[0];
		if (firstLeak !== undefined) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the authorization carries a machine-local path: ${firstLeak.text} — refusing to post it.`,
				renderLeaks(leaks.leaks),
			);
		}

		const target = yield* openPull(
			VERB,
			repo,
			pr,
			(reason) =>
				`${VERB}: cannot read PR #${pr}: ${reason} — whether it can be handed over is UNKNOWN. Nothing was posted.`,
		);
		if (target._tag === "Refused") return target.outcome;
		const {authorLogin: author, baseRef} = target.pull;

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the invoking account: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was posted.`,
			);
		}
		if (sameLogin(viewer.value, author)) {
			return refuse(
				GRANT_UNAUTHORIZED,
				`${VERB}: ${viewer.value} opened PR #${pr} — an author cannot hand their own PR over. Nothing was posted.`,
			);
		}
		const notices = yield* capClearAuthorsNotices(VERB, repo, baseRef);
		// Judged through the reader's own door, so the set that may post a grant and the set whose
		// grant counts can never drift into two.
		const authority = yield* controlPlaneMembership(repo);
		if (authority._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve ${viewer.value}'s authority on ${repo}: ${authority.reason} — nothing was posted.`,
				notices,
			);
		}
		if (authority._tag === "Unusable") {
			return refuse(
				GRANT_UNAUTHORIZED,
				`${VERB}: ${authority.reason}. Nothing was posted.`,
				notices,
			);
		}
		if (!authority.holds(viewer.value)) {
			return refuse(
				GRANT_UNAUTHORIZED,
				`${VERB}: ${viewer.value} is not in ${repo}'s control-plane set at ${authority.ref} — refusing to record a takeover.`,
				notices,
			);
		}
		const permissions = yield* permissionsFor(repo, [viewer.value]);
		if (permissions._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve ${viewer.value}'s repository permission: ${permissions.reason} — authority is UNKNOWN, never granted. Nothing was posted.`,
			);
		}
		const level = permissions.levelOf(viewer.value);
		if (!clearsWriteFloor(level)) {
			return refuse(
				GRANT_UNAUTHORIZED,
				`${VERB}: ${viewer.value} resolves to ${level ?? "no collaboration"} on ${repo}, below write — authority is the ACL's, never CODEOWNERS' alone.`,
			);
		}

		const standing = yield* readPrOwnership(
			repo,
			{number: pr, author, baseRef},
			listComments(repo, pr),
		);
		if (standing._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read whose PR #${pr} is: ${standing.reason} — nothing was posted.`,
			);
		}
		const ownership = standing.ownership;
		if (ownership._tag === "Own") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: PR #${pr} was opened by ${author}, one of ours under ${ownership.basis} — it needs no grant, so there is nothing to hand over.`,
			);
		}
		if (ownership._tag === "Granted") {
			return answer(
				JSON.stringify({
					pr,
					author,
					by: ownership.grant.by,
					comment: ownership.grant.commentId,
					resolvesTo: "already-granted",
				}),
				[...notices, `${VERB}: PR #${pr} was already handed over — nothing was posted.`],
			);
		}

		const at = stampOf(options.now());
		const granted = takeoverGrant.grantedPull(pr);
		if (at === null || granted === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the marker for #${pr} could not be composed — the clock or the number is not one a grant can name. Nothing was posted.`,
			);
		}
		const body = `${takeoverGrant.emit({pr: granted, at})}\n${quoted}\n`;
		const posted = yield* createComment(repo, pr, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the grant write failed: ${posted.reason} — whether it posted is UNKNOWN; read #${pr} before re-running.`,
			);
		}
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the grant posted as comment ${posted.value.id} but the read-back does not match what was sent.`,
			);
		}
		return answer(
			JSON.stringify({
				pr,
				author,
				by: viewer.value,
				comment: posted.value.id,
				at,
				resolvesTo: "granted",
			}),
			[
				...notices,
				`${VERB}: PR #${pr}, opened by ${author}, is handed to the pipeline on ${viewer.value}'s grant.`,
			],
		);
	});
