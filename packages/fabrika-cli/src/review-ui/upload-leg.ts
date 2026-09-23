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
 * LOAD-BEARING NOTE — a fresh `github.com/user-attachments/assets/<uuid>` is NOT readable at its own
 * URL. Probed live on 2026-09-23: the upload answers `201 {"url": …}`, and that URL reads `404`
 * with `authorization: token`, with `Bearer` and anonymously, right away and minutes later, while
 * an asset some posted comment already embeds answers `302`. The bytes are stored, though: GitHub's
 * renderer, asked to render `![…](<url>)` in this repo's context, rewrites a stored asset into a
 * signed `private-user-images.githubusercontent.com/…-<uuid>.png?jwt=…` link that serves `200` with
 * the uploaded bytes, and leaves an unknown uuid as a plain unsigned link. That signed link is also
 * exactly what a posted comment's rendered HTML embeds, so it is what a human opening the PR loads.
 *
 * So the read-back is: render the URL, take the signed `<img>` whose path names this asset's uuid,
 * fetch it anonymously, and require `200` plus the local capture's exact bytes. It runs twice —
 * through `POST /markdown` before anything posts, and through the posted comment's `body_html` after.
 * Anything short of that — a non-`200`, other bytes, no signed link, a transport fault — is a
 * failure: before the post the caller refuses on `17` with nothing posted, after it the caller
 * refuses rather than report success.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9715#issuecomment-5792636866
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {uploadAsset} from "../capture/upload.ts";
import {existenceOf, type RestCall, resolveToken, restCall, restRead} from "../io/gh-api.ts";
import {fail, ok} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import type {
	EvidenceCheck,
	EvidenceCheckResult,
	HostedEvidence,
	UploadLeg,
	UploadResult,
} from "./post-verb.ts";

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

/** PURE: the render call that resolves a hosted URL to its signed link, in `repo`'s context. */
export const renderCall = (hostedUrl: string, repo: string): RestCall => ({
	method: "POST",
	path: "markdown",
	body: {text: `![evidence](${hostedUrl})`, mode: "gfm", context: repo},
	accept: "text/html",
});

/** PURE: the posted comment read, asking for the rendered HTML a human's browser would load. */
export const renderedCommentCall = (repo: string, commentId: number): RestCall => ({
	method: "GET",
	path: `repos/${repo}/issues/comments/${commentId}`,
	accept: "application/vnd.github.html+json",
});

/**
 * PURE: the served link rendered HTML gives the asset at `hostedUrl` — the `<img src>` whose path
 * names the asset's uuid — or `null` when the HTML carries none. Only an `https` link is taken, and
 * the entity-escaped `&` in its signed query is restored.
 */
export const servedAssetUrl = (html: string, hostedUrl: string): string | null => {
	const uuid = hostedUrl.split("/").at(-1) ?? "";
	if (uuid === "") return null;
	for (const match of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)) {
		const src = (match[1] ?? "").replaceAll("&amp;", "&");
		if (!URL.canParse(src)) continue;
		const parsed = new URL(src);
		if (parsed.protocol === "https:" && parsed.pathname.includes(uuid)) return src;
	}
	return null;
};

/**
 * PURE: the probe request. It carries no credential: the signed link is what a rendered page hands
 * any reader, so an anonymous `200` is the proof a human can open it, and the token never travels
 * to the CDN host.
 */
export const probeRequest = (url: string): HttpClientRequest.HttpClientRequest =>
	HttpClientRequest.get(url);

/**
 * PURE: classify a probe status. Only `200` is the asset served — the probe follows redirects, so a
 * `3xx` left standing is a link that never landed on bytes; a `404` is the asset not resolving and
 * stays a failure, which is the refusal this verify exists to feed.
 */
export const classifyProbe = (status: number): string | null =>
	status === 200 ? null : `the hosted asset probed back HTTP ${status}`;

/** PURE: whether the served bytes are the capture's own. */
export const classifyBytes = (served: Uint8Array, expected: Uint8Array): string | null =>
	served.length === expected.length && served.every((byte, index) => byte === expected[index])
		? null
		: `the hosted asset served ${served.length} bytes that are not the ${expected.length}-byte capture`;

/** Fetch the served link for one piece of evidence out of `html`, and hold it to the capture. */
const readBack = (
	html: string,
	evidence: HostedEvidence,
): Effect.Effect<string | null, never, HttpClient.HttpClient> => {
	const served = servedAssetUrl(html, evidence.url);
	if (served === null) {
		return Effect.succeed(
			"GitHub's renderer gave the hosted asset no served link — the upload did not store it",
		);
	}
	return HttpClient.execute(probeRequest(served)).pipe(
		Effect.flatMap((response) => {
			const status = classifyProbe(response.status);
			if (status !== null) return Effect.succeed(status);
			return Effect.map(response.arrayBuffer, (buffer) =>
				classifyBytes(new Uint8Array(buffer), evidence.bytes),
			);
		}),
		Effect.catch((error: unknown) =>
			Effect.succeed(`the hosted asset could not be probed back: ${String(error)}`),
		),
	);
};

/** The rendered HTML one call answers, or why there is none. */
const htmlOf = (
	token: string,
	call: RestCall,
	read: (response: {readonly body: unknown; readonly text: string}) => string | null,
): Effect.Effect<
	{readonly html: string} | {readonly reason: string},
	never,
	HttpClient.HttpClient
> =>
	Effect.map(restCall(token, call), (outcome) => {
		if (outcome._tag === "Unreachable") return {reason: outcome.reason};
		if (outcome.status !== 200) {
			return {reason: `${call.method} ${call.path} answered HTTP ${outcome.status}`};
		}
		const html = read(outcome);
		return html === null
			? {reason: `${call.method} ${call.path} answered 200 with no rendered HTML`}
			: {html};
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
		const rendered = yield* htmlOf(token.value, renderCall(outcome.hostedUrl, request.repo), (r) =>
			r.text === "" ? null : r.text,
		);
		if ("reason" in rendered) {
			return {
				_tag: "Failed",
				reason: `the hosted asset could not be resolved: ${rendered.reason}`,
			} as UploadResult;
		}
		const unverified = yield* readBack(rendered.html, {
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
		const rendered = yield* htmlOf(
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
