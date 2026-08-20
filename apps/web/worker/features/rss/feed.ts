/** Pure RSS 2.0 rendering, kept side-effect-free so it is unit-testable without a worker. */

export interface FeedItem {
	readonly id: string;
	readonly title: string;
	readonly link: string;
	readonly description: string | null;
	readonly pubDate: Date;
}

export interface FeedChannel {
	readonly title: string;
	readonly link: string;
	readonly description: string;
	readonly feedUrl: string;
	readonly items: ReadonlyArray<FeedItem>;
}

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

/** XML-escape text content. `&` first is implicit — the regex alternation is single-pass. */
export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** RFC-822 date, the format RSS `<pubDate>` requires (e.g. `Tue, 10 Jun 2008 11:00:00 GMT`). */
export function rfc822(date: Date): string {
	return date.toUTCString();
}

function renderItem(item: FeedItem): string {
	const parts = [
		`<title>${escapeXml(item.title)}</title>`,
		`<link>${escapeXml(item.link)}</link>`,
		`<guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
		`<pubDate>${rfc822(item.pubDate)}</pubDate>`,
	];
	if (item.description && item.description.length > 0) {
		parts.push(`<description>${escapeXml(item.description)}</description>`);
	}
	return `<item>${parts.join("")}</item>`;
}

/** The `atom` namespace is declared for the `rel="self"` link; the root stays RSS 2.0. */
export function renderFeed(channel: FeedChannel): string {
	const head = [
		`<title>${escapeXml(channel.title)}</title>`,
		`<link>${escapeXml(channel.link)}</link>`,
		`<description>${escapeXml(channel.description)}</description>`,
		`<atom:link href="${escapeXml(channel.feedUrl)}" rel="self" type="application/rss+xml"/>`,
	].join("");
	const items = channel.items.map(renderItem).join("");
	return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>${head}${items}</channel></rss>`;
}
