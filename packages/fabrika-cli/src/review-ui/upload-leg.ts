/**
 * The production {@link UploadLeg}: upload one capture to the GitHub user-attachment tier and
 * **probe the result back** before calling it evidence.
 *
 * The upload itself is the capture module's `uploadAsset`, imported — what this file adds is the
 * half that module deliberately does not have. Its error channel is `never` by contract, because
 * for the v1 gate hosting was display-only; here the hosted URL is a precondition of the verdict,
 * so an unverified URL is a failure rather than a decoration (#3925).
 *
 * The probe is a real fetch of the returned URL, carrying the same token the upload used.
 *
 * LOAD-BEARING NOTE — `github.com/user-attachments/assets/<uuid>` is AUTH-GATED ON READ. Probed
 * against the live endpoint (#6520): anonymous is `404`, `authorization: token <t>` is `302` to the
 * signed CDN URL, and following that redirect is `200`. So the probe must send the token or it
 * reads every healthy upload back as missing. A human opening the PR reads the attachment through
 * their own GitHub session, the same tier every drag-and-dropped screenshot on this repo uses.
 *
 * Anything that is not a served response — a 4xx/5xx under that authenticated probe, a transport
 * fault — is `Failed`, and the caller refuses on `17` with nothing posted.
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {uploadAsset} from "../capture/upload.ts";
import {existenceOf, resolveToken, restRead} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import type {UploadLeg, UploadResult} from "./post-verb.ts";

/**
 * The repo's numeric id, which the undocumented attachment endpoint requires (404 without it).
 *
 * The token is an argument because the package resolves one and only one (ADR 0315) — this file
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

/**
 * PURE: the probe request. The token is a required argument rather than something resolved in
 * here, so an unauthenticated probe — the shape that read every healthy upload back as `404`
 * (#6520) — has no way to be constructed.
 */
export const probeRequest = (url: string, token: string): HttpClientRequest.HttpClientRequest =>
	HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({authorization: `token ${token}`}));

/**
 * PURE: classify a probe status. The `302` the authenticated probe answers with is the asset being
 * served, so the served band runs to 400; a `404` is the asset genuinely not resolving and stays a
 * failure, which is the #3925 refusal this verify exists to feed.
 */
export const classifyProbe = (status: number): string | null =>
	status >= 200 && status < 400 ? null : `the hosted asset probed back HTTP ${status}`;

const verify = (
	url: string,
	token: string,
): Effect.Effect<string | null, never, HttpClient.HttpClient> =>
	HttpClient.execute(probeRequest(url, token)).pipe(
		Effect.map((response) => classifyProbe(response.status)),
		Effect.catch((error: unknown) =>
			Effect.succeed(`the hosted asset could not be probed back: ${String(error)}`),
		),
	);

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
		const unverified = yield* verify(outcome.hostedUrl, token.value);
		return unverified === null
			? ({_tag: "Hosted", url: outcome.hostedUrl} as UploadResult)
			: ({_tag: "Failed", reason: unverified} as UploadResult);
	});
