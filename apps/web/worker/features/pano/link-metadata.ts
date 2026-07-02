/**
 * The pure core of the pano link-metadata prefill route (#1642): the SSRF
 * guard that decides whether a user-supplied URL is safe to fetch, and the
 * HTML metadata parser that lifts `og:title`/`<title>` and
 * `og:description`/`meta[name=description]` out of a fetched page. Both are
 * pure and unit-testable without a worker or a live network.
 *
 * A public worker that fetches arbitrary user-supplied URLs is the classic
 * SSRF surface, so {@link isSafeFetchUrl} is fail-closed: it admits ONLY
 * `http(s)` URLs whose host is not a private/loopback/link-local/CGNAT/
 * cloud-metadata address (IPv4 or IPv6 literal) and not a local-only hostname
 * (`localhost`, `*.localhost`, `*.local`, `*.internal`). A hostname that is
 * not an IP literal still can't be pre-resolved to an IP from inside the
 * worker, so the DNS-rebinding residue is accepted as a known bound — the
 * literal-IP + local-suffix screen blocks the direct-address SSRF vectors,
 * and the fetch itself is timeout- and size-bounded by the route.
 */

import type {LinkMetadata} from "./link-metadata-contract.ts";

/** Max bytes of the response body the route buffers before giving up (a graceful no-op). */
export const MAX_METADATA_BYTES = 512 * 1024;

/** How long the server-side fetch may run before it's aborted (a graceful no-op). */
export const FETCH_TIMEOUT_MS = 5_000;

/**
 * Max 3xx redirects the server-side fetch follows before giving up. The route
 * follows redirects MANUALLY and re-screens every hop's `Location` through
 * {@link isSafeFetchUrl}, so a public URL that 302s to `169.254.169.254` (or any
 * private/loopback/link-local/metadata target) is refused — the SSRF-via-redirect
 * vector a blind `redirect: "follow"` would chase. A chain longer than this cap
 * is also refused (a graceful no-op).
 */
export const MAX_REDIRECT_HOPS = 5;

/** Longest title/description the route returns — prefill stays editable and bounded. */
export const MAX_FIELD_LEN = 300;

/** Hostname suffixes that only ever resolve to a local/internal host. */
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

const isDottedIPv4 = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/** A private/loopback/link-local/CGNAT/broadcast/unspecified IPv4 literal. */
function isBlockedIPv4(host: string): boolean {
	const parts = host.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		// Malformed dotted-quad → treat as blocked (fail-closed).
		return true;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 0) return true; // 0.0.0.0/8 "this host"
	if (a === 10) return true; // 10.0.0.0/8 private
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 cloud metadata)
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
	if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (incl. 255.255.255.255)
	return false;
}

/**
 * The IPv4 embedded in an IPv4-mapped IPv6 tail, as dotted-quad. The tail is
 * either dotted (`127.0.0.1`) or the two hex hextets WHATWG normalizes it to
 * (`7f00:1`). An unrecognized tail returns `"256.0.0.0"` — an out-of-range
 * sentinel {@link isBlockedIPv4} treats as blocked (fail-closed).
 */
function mappedTailToIPv4(tail: string): string {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
	const groups = tail.split(":");
	if (groups.length !== 2) return "256.0.0.0";
	const hi = Number.parseInt(groups[0] ?? "", 16);
	const lo = Number.parseInt(groups[1] ?? "", 16);
	if (!Number.isInteger(hi) || !Number.isInteger(lo)) return "256.0.0.0";
	return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".");
}

/**
 * A blocked IPv6 literal (as it appears inside `URL.hostname`, i.e. without the
 * `[...]` brackets). Covers loopback, unspecified, unique-local (`fc00::/7`),
 * link-local (`fe80::/10`), and IPv4-mapped addresses whose embedded IPv4 is
 * itself blocked.
 */
function isBlockedIPv6(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "::1" || h === "::") return true; // loopback / unspecified
	// IPv4-mapped (`::ffff:a.b.c.d`, which WHATWG normalizes to `::ffff:HHHH:HHHH`)
	// — screen the embedded IPv4, fail-closed on an unparseable tail.
	if (h.startsWith("::ffff:")) return isBlockedIPv4(mappedTailToIPv4(h.slice("::ffff:".length)));
	const firstHextet = h.split(":")[0] ?? "";
	if (firstHextet.startsWith("fe8") || firstHextet.startsWith("fe9")) return true; // fe80::/10 link-local
	if (firstHextet.startsWith("fea") || firstHextet.startsWith("feb")) return true; // fe80::/10 link-local
	if (firstHextet.startsWith("fc") || firstHextet.startsWith("fd")) return true; // fc00::/7 unique-local
	return false;
}

/**
 * Parse `raw` and return the {@link URL} only if it is safe to fetch
 * server-side; otherwise `null`. Fail-closed: an unparseable URL, a
 * non-`http(s)` scheme, or a private/loopback/link-local/CGNAT/metadata IP
 * literal or local-only hostname all return `null`.
 */
export function isSafeFetchUrl(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;

	const host = url.hostname.toLowerCase();
	if (host === "" || host === "localhost") return null;
	if (LOCAL_HOST_SUFFIXES.some((s) => host.endsWith(s))) return null;

	// `URL.hostname` keeps the `[...]` around an IPv6 literal (WHATWG URL) —
	// strip them before the address screen.
	if (host.startsWith("[") && host.endsWith("]")) {
		return isBlockedIPv6(host.slice(1, -1)) ? null : url;
	}
	if (isDottedIPv4(host)) return isBlockedIPv4(host) ? null : url;

	return url;
}

/** Decode the handful of HTML entities that show up in title/description text. */
function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Normalize extracted text: decode entities, collapse whitespace, trim, cap length. */
function clean(text: string): string {
	return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_LEN);
}

/** Parse one `<meta …>` tag's attributes into a lowercase-keyed map. */
function metaAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	for (let m = re.exec(tag); m !== null; m = re.exec(tag)) {
		const name = m[1]?.toLowerCase();
		const value = m[3] ?? m[4] ?? "";
		if (name) attrs[name] = value;
	}
	return attrs;
}

/**
 * The first non-empty `<meta>` content matching a key, honoring KEY PRIORITY
 * over document order: each key in `keys` is tried in turn (`og:*` before the
 * plain fallback), and the whole document is scanned per key. Attribute order
 * within a tag is irrelevant — `content` may precede or follow `property`.
 */
function metaContent(html: string, keys: readonly string[]): string | undefined {
	const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
	const byId = new Map<string, string>();
	for (const tag of tags) {
		const attrs = metaAttrs(tag);
		const id = (attrs.property ?? attrs.name)?.toLowerCase();
		if (id && attrs.content !== undefined && !byId.has(id)) {
			const value = clean(attrs.content);
			if (value !== "") byId.set(id, value);
		}
	}
	for (const key of keys) {
		const value = byId.get(key.toLowerCase());
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Lift the page title and description out of raw HTML. Title prefers
 * `og:title`, falling back to `<title>`; description prefers `og:description`,
 * falling back to `meta[name=description]`. A field with no source is absent —
 * the client then leaves that form field untouched.
 */
export function parseLinkMetadata(html: string): LinkMetadata {
	const result: {title?: string; description?: string} = {};

	let title = metaContent(html, ["og:title", "twitter:title"]);
	if (title === undefined) {
		const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
		if (m?.[1]) {
			const value = clean(m[1]);
			if (value !== "") title = value;
		}
	}
	if (title !== undefined) result.title = title;

	const description = metaContent(html, ["og:description", "twitter:description", "description"]);
	if (description !== undefined) result.description = description;

	return result;
}
