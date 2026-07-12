/**
 * `GET /api/pano/link-metadata?url=…` (#1642) — the pano submit form's
 * title/description prefill seam. The browser can't fetch cross-origin HTML,
 * so the worker does it: given an SSRF-safe `http(s)` URL it fetches the page
 * (timeout- and size-bounded, following redirects manually so every hop is
 * re-screened for SSRF), parses its metadata, and returns {@link LinkMetadata}
 * as JSON. See `.patterns/alchemy-http-router.md`.
 *
 * Every failure mode is a graceful no-op, never a 5xx: an unsafe/rejected URL,
 * a fetch error, a timeout, an over-cap body, a non-2xx upstream, or a page
 * with no usable metadata all return `{}` (200) — the client then leaves the
 * form fields untouched. The route holds no per-request services; it only
 * reads the raw `Request` for the `url` query param.
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

/** The empty result — the safe-default this route returns on every failure. */
const EMPTY: LinkMetadata = {};

/** An unexpected `fetchMetadata` rejection — mapped then recovered to {@link EMPTY}. */
class LinkMetadataFetchError extends Schema.TaggedErrorClass<LinkMetadataFetchError>()(
	"pano/LinkMetadataFetchError",
	{cause: Schema.Defect()},
) {}

/**
 * Read up to {@link MAX_METADATA_BYTES} of the response body as UTF-8, then
 * stop — never buffer an unbounded body. Returns the decoded prefix (enough to
 * hold the `<head>` metadata for any sane page).
 */
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
 * Fetch `start` following up to {@link MAX_REDIRECT_HOPS} 3xx redirects
 * MANUALLY (`redirect: "manual"`), re-screening every hop's `Location` through
 * {@link isSafeFetchUrl} BEFORE following it. `redirect: "follow"` would chase a
 * `302 Location: http://169.254.169.254/…` blindly, defeating the initial-URL
 * guard — so each hop is resolved against the current URL and re-validated, and
 * a hop that fails the guard (or a chain past the cap) returns `null` (refused).
 * The single `signal` spans the whole chain, so the route's 5s timeout bounds
 * every hop. `fetchImpl` is injectable so the loop is unit-testable offline.
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

/** Fetch + parse a safe URL's metadata. Any failure collapses to `{}` (no throw). */
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
	// `fetchMetadata` never rejects — it maps every failure to `EMPTY` — so the
	// mapped-then-recovered `catch` is unreachable and the route can't surface a
	// defect to the client.
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
