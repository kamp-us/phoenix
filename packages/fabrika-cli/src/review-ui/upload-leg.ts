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
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {uploadAsset} from "../capture/upload.ts";
import {execCapture} from "../io/exec.ts";
import {isRecord, parseJson} from "../io/json.ts";
import type {UploadLeg, UploadResult} from "./post-verb.ts";

/** The repo's numeric id, which the undocumented attachment endpoint requires (404 without it). */
const repositoryId = (repo: string) =>
	Effect.gen(function* () {
		const result = yield* execCapture("gh", ["api", `repos/${repo}`]);
		if (!result.ok) return null;
		const parsed = parseJson(result.stdout);
		return isRecord(parsed) && typeof parsed.id === "number" ? parsed.id : null;
	});

/** The token the endpoint authenticates with — the env first, else whatever `gh` is logged in as. */
const uploadToken = (env: Readonly<Record<string, string | undefined>>) =>
	Effect.gen(function* () {
		const fromEnv = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "";
		if (fromEnv.trim() !== "") return fromEnv.trim();
		const result = yield* execCapture("gh", ["auth", "token"]);
		const token = result.stdout.trim();
		return result.ok && token !== "" ? token : null;
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

const verify = (url: string, token: string): Effect.Effect<string | null> =>
	HttpClient.execute(probeRequest(url, token)).pipe(
		Effect.map((response) => classifyProbe(response.status)),
		Effect.catch((error: unknown) =>
			Effect.succeed(`the hosted asset could not be probed back: ${String(error)}`),
		),
		Effect.provide(FetchHttpClient.layer),
	);

export const githubAttachmentUploadLeg = (
	env: Readonly<Record<string, string | undefined>>,
): UploadLeg =>
	Effect.fn(function* (request) {
		const id = yield* repositoryId(request.repo);
		if (id === null) {
			return {
				_tag: "Failed",
				reason: `cannot resolve ${request.repo}'s numeric id`,
			} as UploadResult;
		}
		const token = yield* uploadToken(env);
		if (token === null) {
			return {
				_tag: "Failed",
				reason: "no upload token — set GITHUB_TOKEN or log in with `gh auth login`",
			} as UploadResult;
		}
		const outcome = yield* uploadAsset({
			pngBytes: request.bytes,
			repositoryId: id,
			token,
			fileName: request.fileName,
		}).pipe(Effect.provide(FetchHttpClient.layer));
		if (outcome.hostedUrl === null) {
			return {
				_tag: "Failed",
				reason: outcome.uploadError ?? "the upload returned no hosted URL",
			} as UploadResult;
		}
		const unverified = yield* verify(outcome.hostedUrl, token);
		return unverified === null
			? ({_tag: "Hosted", url: outcome.hostedUrl} as UploadResult)
			: ({_tag: "Failed", reason: unverified} as UploadResult);
	});
