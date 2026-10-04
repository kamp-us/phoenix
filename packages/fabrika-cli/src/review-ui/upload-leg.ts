/**
 * The production {@link UploadLeg}: upload one capture to the GitHub user-attachment tier and
 * **read it back** before calling it evidence — plus the {@link EvidenceCheck} that re-reads the
 * same evidence out of the posted comment.
 *
 * The upload itself is the capture module's `uploadAsset`, imported — what this file adds is the
 * half that module deliberately does not have. Its error channel is `never` by contract, because
 * for the v1 gate hosting was display-only; here the hosted URL is a precondition of the verdict,
 * so an unverified URL is a failure rather than a decoration.
 *
 * The read-back is `../io/attachment-read-back.ts`'s, shared with `ui evidence`, and runs twice —
 * through `POST /markdown` before anything posts, and through the posted comment's `body_html` after.
 * Before the post a failure makes the caller refuse on `17` with nothing posted; after it the caller
 * refuses rather than report success.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9715#issuecomment-5792636866
 */
import {Effect} from "effect";
import {uploadAsset} from "../capture/upload.ts";
import {readBack, readBackThroughRenderer, renderedHtml} from "../io/attachment-read-back.ts";
import {existenceOf, type RestCall, resolveToken, restRead} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import type {EvidenceCheck, EvidenceCheckResult, UploadLeg, UploadResult} from "./post-verb.ts";

/**
 * The repo's numeric id, which the undocumented attachment endpoint requires (404 without it).
 *
 * The token is an argument because the package resolves one and only one — this file
 * keeps no copy of that resolution, and the read that used to run anonymously through `gh api` now
 * runs authenticated through the same client the probe and the upload use.
 */
const repositoryId = (token: string, repo: string) =>
	Effect.gen(function* () {
		const read = existenceOf(yield* restRead(token, "GET", `repos/${repo}`), (body) =>
			isRecord(body) && typeof body.id === "number"
				? ok(body.id)
				: fail("GitHub answered 200 but named no repository id"),
		);
		return read._tag === "Present" ? read.value : null;
	});

/** PURE: the posted comment read, asking for the rendered HTML a human's browser would load. */
export const renderedCommentCall = (repo: string, commentId: number): RestCall => ({
	method: "GET",
	path: `repos/${repo}/issues/comments/${commentId}`,
	accept: "application/vnd.github.html+json",
});

export const githubAttachmentUploadLeg = (
	env: Readonly<Record<string, string | undefined>>,
): UploadLeg =>
	Effect.fn(function* (request) {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") {
			return {_tag: "Failed", reason: token.reason} as UploadResult;
		}
		const id = yield* repositoryId(token.value, request.repo);
		if (id === null) {
			return {
				_tag: "Failed",
				reason: `cannot resolve ${request.repo}'s numeric id`,
			} as UploadResult;
		}
		const outcome = yield* uploadAsset({
			pngBytes: request.bytes,
			repositoryId: id,
			token: token.value,
			fileName: request.fileName,
		});
		if (outcome.hostedUrl === null) {
			return {
				_tag: "Failed",
				reason: outcome.uploadError ?? "the upload returned no hosted URL",
			} as UploadResult;
		}
		const unverified = yield* readBackThroughRenderer(token.value, request.repo, {
			url: outcome.hostedUrl,
			bytes: request.bytes,
		});
		return unverified === null
			? ({_tag: "Hosted", url: outcome.hostedUrl} as UploadResult)
			: ({_tag: "Failed", reason: unverified} as UploadResult);
	});

const RESOLVED: EvidenceCheckResult = {_tag: "Resolved"};

const unresolved = (reasons: readonly [string, ...string[]]): EvidenceCheckResult => ({
	_tag: "Unresolved",
	reasons,
});

/** Read the posted comment's rendered HTML and hold every embedded capture to its bytes. */
export const githubPostedEvidenceCheck = (
	env: Readonly<Record<string, string | undefined>>,
): EvidenceCheck =>
	Effect.fn(function* (request) {
		const token = yield* resolveToken(env);
		if (token._tag === "Failure") return unresolved([token.reason]);
		const rendered = yield* renderedHtml(
			token.value,
			renderedCommentCall(request.repo, request.commentId),
			(r) => (isRecord(r.body) && typeof r.body.body_html === "string" ? r.body.body_html : null),
		);
		if ("reason" in rendered) {
			return unresolved([`the posted comment could not be read: ${rendered.reason}`]);
		}
		const reasons: string[] = [];
		for (const evidence of request.evidence) {
			const failure = yield* readBack(rendered.html, evidence);
			if (failure !== null) reasons.push(`${evidence.url}: ${failure}`);
		}
		const [first, ...rest] = reasons;
		return first === undefined ? RESOLVED : unresolved([first, ...rest]);
	});
