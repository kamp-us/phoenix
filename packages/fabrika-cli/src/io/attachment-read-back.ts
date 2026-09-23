/**
 * The one read-back of a GitHub user-attachment upload, shared by `ui evidence` and
 * `review-ui post`: an upload is evidence only once GitHub serves its exact bytes back.
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
 * fetch it anonymously, and require `200` plus the local capture's exact bytes. The token goes to
 * the GitHub API only; the served-asset host never sees it. Anything short of that — a non-`200`,
 * other bytes, no signed link, a transport fault — is a failure reason, never a pass.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9715#issuecomment-5792636866
 */
import {Effect} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {type RestCall, restCall} from "./gh-api.ts";
import {isRecord} from "./json.ts";

/** One uploaded capture: the URL the upload returned, and the local bytes it must serve. */
export interface HostedCapture {
	readonly url: string;
	readonly bytes: Uint8Array;
}

/** PURE: the render call that resolves a hosted URL to its signed link, in `repo`'s context. */
export const renderCall = (hostedUrl: string, repo: string): RestCall => ({
	method: "POST",
	path: "markdown",
	body: {text: `![evidence](${hostedUrl})`, mode: "gfm", context: repo},
	accept: "text/html",
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
 * stays a failure, which is the refusal this read-back exists to feed.
 */
export const classifyProbe = (status: number): string | null =>
	status === 200 ? null : `the hosted asset probed back HTTP ${status}`;

/** PURE: whether the served bytes are the capture's own. */
export const classifyBytes = (served: Uint8Array, expected: Uint8Array): string | null =>
	served.length === expected.length && served.every((byte, index) => byte === expected[index])
		? null
		: `the hosted asset served ${served.length} bytes that are not the ${expected.length}-byte capture`;

/**
 * The fault's tag and nothing else: an HTTP client error prints its request, and the signed link's
 * query is a credential.
 */
const faultTag = (error: unknown): string =>
	isRecord(error) && typeof error._tag === "string" ? error._tag : "unknown fault";

/** Fetch the served link for one capture out of `html`, and hold it to the capture's bytes. */
export const readBack = (
	html: string,
	capture: HostedCapture,
): Effect.Effect<string | null, never, HttpClient.HttpClient> => {
	const served = servedAssetUrl(html, capture.url);
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
				classifyBytes(new Uint8Array(buffer), capture.bytes),
			);
		}),
		Effect.catch((error: unknown) =>
			Effect.succeed(`the hosted asset could not be probed back (${faultTag(error)})`),
		),
	);
};

/** The rendered HTML one API call answers, or why there is none. */
export const renderedHtml = (
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

/**
 * The pre-post read-back: render the fresh URL through `POST /markdown` in `repo`'s context, then
 * hold the signed link it yields to the capture. `null` is the capture served; a string is why not.
 */
export const readBackThroughRenderer = (
	token: string,
	repo: string,
	capture: HostedCapture,
): Effect.Effect<string | null, never, HttpClient.HttpClient> =>
	Effect.flatMap(
		renderedHtml(token, renderCall(capture.url, repo), (r) => (r.text === "" ? null : r.text)),
		(rendered) =>
			"reason" in rendered
				? Effect.succeed(`the hosted asset could not be resolved: ${rendered.reason}`)
				: readBack(rendered.html, capture),
	);
