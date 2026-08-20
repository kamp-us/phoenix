/**
 * `GET /api/pano/link-metadata?url=…` — the pano submit form's title/description
 * prefill seam, fetched worker-side because the browser can't fetch cross-origin
 * HTML. See `.patterns/alchemy-http-router.md`.
 *
 * Every failure mode is a graceful no-op, never a 5xx: unsafe URL, fetch error,
 * timeout, over-cap body, non-2xx upstream, or no usable metadata all return `{}`.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
	FETCH_TIMEOUT_MS,
	isSafeFetchUrl,
	MAX_METADATA_BYTES,
	MAX_REDIRECT_HOPS,
	parseLinkMetadata,
	resolveUrl,
} from "./link-metadata.ts";
import type {LinkMetadata} from "./link-metadata-contract.ts";

const EMPTY: LinkMetadata = {};

class LinkMetadataFetchError extends Schema.TaggedErrorClass<LinkMetadataFetchError>()(
	"pano/LinkMetadataFetchError",
	{cause: Schema.Defect()},
) {}

/** Stops at {@link MAX_METADATA_BYTES} — never buffer an unbounded body. */
async function readCapped(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let total = 0;
	for (;;) {
		const {done, value} = await reader.read();
		if (done) break;
		total += value.byteLength;
		text += decoder.decode(value, {stream: true});
		if (total >= MAX_METADATA_BYTES) {
			await reader.cancel();
			break;
		}
	}
	return text;
}

/**
 * Redirects are followed MANUALLY so every hop's `Location` is re-screened through
 * {@link isSafeFetchUrl} BEFORE it is followed. `redirect: "follow"` would chase a
 * `302 Location: http://169.254.169.254/…` blindly, defeating the initial-URL guard.
 * The single `signal` spans the whole chain, so one timeout bounds every hop.
 */
async function fetchFollowingSafeRedirects(
	start: URL,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
	let current = start;
	for (let redirects = 0; ; redirects++) {
		const res = await fetchImpl(current.toString(), {
			method: "GET",
			redirect: "manual",
			signal,
			headers: {accept: "text/html,application/xhtml+xml"},
		});
		if (res.status < 300 || res.status >= 400) return res;
		if (redirects >= MAX_REDIRECT_HOPS) return null;
		const location = res.headers.get("location");
		if (location === null || location === "") return null;
		const next = resolveUrl(location, current);
		if (next === null) return null;
		const safe = isSafeFetchUrl(next.toString());
		if (safe === null) return null;
		current = safe;
	}
}

/** Any failure collapses to `{}` — this never throws. */
async function fetchMetadata(url: URL): Promise<LinkMetadata> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchFollowingSafeRedirects(url, controller.signal);
		if (res === null || !res.ok) return EMPTY;
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType !== "" && !/html|xml/i.test(contentType)) return EMPTY;
		const html = await readCapped(res);
		return parseLinkMetadata(html);
	} catch {
		return EMPTY;
	} finally {
		clearTimeout(timer);
	}
}

export {fetchFollowingSafeRedirects};

export const handleLinkMetadata = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const requested = new URL(raw.url).searchParams.get("url") ?? "";
	const safe = isSafeFetchUrl(requested);
	if (safe === null) return HttpServerResponse.jsonUnsafe(EMPTY);
	// `fetchMetadata` never rejects, so this `catch` is unreachable — it is here so
	// the route structurally cannot surface a defect to the client.
	const metadata = yield* Effect.tryPromise({
		try: () => fetchMetadata(safe),
		catch: (cause) => new LinkMetadataFetchError({cause}),
	}).pipe(Effect.orElseSucceed(() => EMPTY));
	return HttpServerResponse.jsonUnsafe(metadata);
});

export const linkMetadataRoute = HttpRouter.add(
	"GET",
	"/api/pano/link-metadata",
	handleLinkMetadata,
);
