/**
 * The pure core of the pano link-metadata prefill route (#1642): the SSRF guard
 * (`isSafeFetchUrl`) and the HTML metadata parser (`parseLinkMetadata`). Both
 * are tested here without a worker or a live network — the same testable-pure-
 * core idiom as `evaluate-contract.unit.test.ts`.
 *
 * `isSafeFetchUrl` is the security surface: it must admit only public `http(s)`
 * targets and reject every private/loopback/link-local/CGNAT/metadata address
 * and local-only hostname (AC: "rejects non-http(s) schemes and private/…IPs").
 * `parseLinkMetadata` must prefer `og:*` and fall back to `<title>` / `meta
 * description`, and yield an absent field (never a throw) when a source is
 * missing.
 */
import {describe, expect, it} from "vitest";
import {isSafeFetchUrl, MAX_FIELD_LEN, parseLinkMetadata} from "./link-metadata.ts";

describe("isSafeFetchUrl — schemes", () => {
	it("admits a public https URL", () => {
		expect(isSafeFetchUrl("https://overreacted.io/some-post")?.hostname).toBe("overreacted.io");
	});

	it("admits a public http URL", () => {
		expect(isSafeFetchUrl("http://example.com")?.hostname).toBe("example.com");
	});

	it.each([
		"ftp://example.com",
		"file:///etc/passwd",
		"data:text/html,x",
		"javascript:alert(1)",
	])("rejects the non-http(s) scheme %s", (url) => {
		expect(isSafeFetchUrl(url)).toBeNull();
	});

	it("rejects an unparseable URL", () => {
		expect(isSafeFetchUrl("not a url")).toBeNull();
		expect(isSafeFetchUrl("")).toBeNull();
	});
});

describe("isSafeFetchUrl — SSRF address/host screen", () => {
	it.each([
		"http://127.0.0.1/",
		"http://127.0.0.5:8080/",
		"http://10.0.0.1/",
		"http://172.16.5.4/",
		"http://172.31.255.255/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
		"http://0.0.0.0/",
		"http://100.64.0.1/", // CGNAT
		"http://255.255.255.255/", // broadcast
		"http://localhost/",
		"http://sub.localhost/",
		"http://printer.local/",
		"http://db.internal/",
		"http://[::1]/", // IPv6 loopback
		"http://[fe80::1]/", // IPv6 link-local
		"http://[fc00::1]/", // IPv6 unique-local
		"http://[fd12:3456::1]/", // IPv6 unique-local
		"http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
	])("rejects the private/local target %s", (url) => {
		expect(isSafeFetchUrl(url)).toBeNull();
	});

	it("admits a public IPv4 literal", () => {
		expect(isSafeFetchUrl("http://93.184.216.34/")?.hostname).toBe("93.184.216.34");
	});

	it("admits 172.15/172.32 (just outside the private 172.16/12 range)", () => {
		expect(isSafeFetchUrl("http://172.15.0.1/")).not.toBeNull();
		expect(isSafeFetchUrl("http://172.32.0.1/")).not.toBeNull();
	});
});

describe("parseLinkMetadata — title", () => {
	it("prefers og:title over <title>", () => {
		const html = `<title>tab title</title><meta property="og:title" content="OG Title">`;
		expect(parseLinkMetadata(html).title).toBe("OG Title");
	});

	it("falls back to <title> when there is no og:title", () => {
		expect(parseLinkMetadata("<title>Just Title</title>").title).toBe("Just Title");
	});

	it("reads og:title regardless of attribute order", () => {
		const html = `<meta content="Reversed" property="og:title">`;
		expect(parseLinkMetadata(html).title).toBe("Reversed");
	});

	it("leaves title absent when there is no source", () => {
		expect(parseLinkMetadata("<p>no metadata here</p>").title).toBeUndefined();
	});

	it("decodes entities and collapses whitespace", () => {
		const html = `<title>Foo &amp; Bar\n   baz</title>`;
		expect(parseLinkMetadata(html).title).toBe("Foo & Bar baz");
	});
});

describe("parseLinkMetadata — description", () => {
	it("prefers og:description over meta[name=description]", () => {
		const html = `<meta name="description" content="plain"><meta property="og:description" content="og">`;
		expect(parseLinkMetadata(html).description).toBe("og");
	});

	it("falls back to meta[name=description]", () => {
		const html = `<meta name="description" content="the description">`;
		expect(parseLinkMetadata(html).description).toBe("the description");
	});

	it("leaves description absent when there is no source", () => {
		expect(parseLinkMetadata("<title>x</title>").description).toBeUndefined();
	});
});

describe("parseLinkMetadata — bounds", () => {
	it("caps a very long title at MAX_FIELD_LEN", () => {
		const html = `<title>${"a".repeat(MAX_FIELD_LEN + 100)}</title>`;
		expect(parseLinkMetadata(html).title?.length).toBe(MAX_FIELD_LEN);
	});

	it("never throws on empty or garbage input", () => {
		expect(parseLinkMetadata("")).toEqual({});
		expect(parseLinkMetadata("<<<>>><meta>")).toEqual({});
	});
});
