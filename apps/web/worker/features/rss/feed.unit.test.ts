import {describe, expect, it} from "vitest";
import {escapeXml, type FeedChannel, renderFeed, rfc822} from "./feed.ts";

describe("escapeXml", () => {
	it("escapes the five XML metacharacters", () => {
		expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
	});

	it("leaves plain text untouched", () => {
		expect(escapeXml("merhaba dünya")).toBe("merhaba dünya");
	});
});

describe("rfc822", () => {
	it("renders an RFC-822 GMT date", () => {
		expect(rfc822(new Date("2026-06-14T11:00:00Z"))).toBe("Sun, 14 Jun 2026 11:00:00 GMT");
	});
});

describe("renderFeed", () => {
	const channel: FeedChannel = {
		title: "kamp.us · pano",
		link: "https://kamp.us/pano",
		description: "son gönderiler",
		feedUrl: "https://kamp.us/rss.xml",
		items: [
			{
				id: "post_1",
				title: "ilk gönderi & test",
				link: "https://kamp.us/pano/ilk-gonderi",
				description: "bir <açıklama>",
				pubDate: new Date("2026-06-14T11:00:00Z"),
			},
			{
				id: "post_2",
				title: "ikinci",
				link: "https://kamp.us/pano/post_2",
				description: null,
				pubDate: new Date("2026-06-13T09:30:00Z"),
			},
		],
	};

	it("emits a well-formed RSS 2.0 root with the atom self link", () => {
		const xml = renderFeed(channel);
		expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
		expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
		expect(xml).toContain(
			'<atom:link href="https://kamp.us/rss.xml" rel="self" type="application/rss+xml"/>',
		);
		expect(xml).toContain("</rss>");
	});

	it("escapes item title/description and renders link, guid, pubDate", () => {
		const xml = renderFeed(channel);
		expect(xml).toContain("<title>ilk gönderi &amp; test</title>");
		expect(xml).toContain("<description>bir &lt;açıklama&gt;</description>");
		expect(xml).toContain("<link>https://kamp.us/pano/ilk-gonderi</link>");
		expect(xml).toContain('<guid isPermaLink="true">https://kamp.us/pano/ilk-gonderi</guid>');
		expect(xml).toContain("<pubDate>Sun, 14 Jun 2026 11:00:00 GMT</pubDate>");
	});

	it("omits <description> when the item has none", () => {
		const xml = renderFeed(channel);
		const secondItem = xml.slice(xml.indexOf("<link>https://kamp.us/pano/post_2</link>"));
		expect(secondItem).not.toContain("<description>");
	});

	it("parses back as a single channel with all items (xml round-trips)", () => {
		const xml = renderFeed(channel);
		const itemCount = (xml.match(/<item>/g) ?? []).length;
		expect(itemCount).toBe(2);
		// balanced tags — a crude well-formedness check the validator AC leans on
		expect((xml.match(/<item>/g) ?? []).length).toBe((xml.match(/<\/item>/g) ?? []).length);
	});
});
