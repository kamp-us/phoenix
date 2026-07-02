/**
 * `GET /api/pano/link-metadata?url=…` (#1642) — the pano submit form's
 * title/description prefill seam. The browser can't fetch cross-origin HTML,
 * so the worker does it: given an SSRF-safe `http(s)` URL it fetches the page
 * (timeout- and size-bounded), parses its metadata, and returns
 * {@link LinkMetadata} as JSON. See `.patterns/alchemy-http-router.md`.
 *
 * Every failure mode is a graceful no-op, never a 5xx: an unsafe/rejected URL,
 * a fetch error, a timeout, an over-cap body, a non-2xx upstream, or a page
 * with no usable metadata all return `{}` (200) — the client then leaves the
 * form fields untouched. The route holds no per-request services; it only
 * reads the raw `Request` for the `url` query param.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
	FETCH_TIMEOUT_MS,
	isSafeFetchUrl,
	MAX_METADATA_BYTES,
	parseLinkMetadata,
} from "./link-metadata.ts";
import type {LinkMetadata} from "./link-metadata-contract.ts";

/** The empty result — the safe-default this route returns on every failure. */
const EMPTY: LinkMetadata = {};

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

/** Fetch + parse a safe URL's metadata. Any failure collapses to `{}` (no throw). */
async function fetchMetadata(url: URL): Promise<LinkMetadata> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url.toString(), {
			method: "GET",
			redirect: "follow",
			signal: controller.signal,
			headers: {accept: "text/html,application/xhtml+xml"},
		});
		if (!res.ok) return EMPTY;
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

export const handleLinkMetadata = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const requested = new URL(raw.url).searchParams.get("url") ?? "";
	const safe = isSafeFetchUrl(requested);
	if (safe === null) return HttpServerResponse.jsonUnsafe(EMPTY);
	// `Effect.promise` because `fetchMetadata` never rejects — it maps every
	// failure to `EMPTY`, so the route can't surface a defect to the client.
	const metadata = yield* Effect.promise(() => fetchMetadata(safe));
	return HttpServerResponse.jsonUnsafe(metadata);
});

export const linkMetadataRoute = HttpRouter.add(
	"GET",
	"/api/pano/link-metadata",
	handleLinkMetadata,
);
