/**
 * The preview-URL resolver — keyed off the per-app `<!-- preview-deploy:<app> -->`
 * anchor from the sticky preview-deploy comment (deploy.yml / ci.yml `webRe`).
 * The load-bearing case is multi-app: resolution must NOT return the first
 * `workers.dev` URL in the comment, or a second app's line would shadow web's.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	announcedApps,
	isPreviewAnnouncement,
	readPreviewAnnouncement,
	resolvePreviewUrl,
} from "./resolve.ts";

// The exact block shape deploy.yml's "Comment preview URL" step upserts.
const webBlock = (url: string, sha = "abc1234", db = "11111111-2222-3333-4444-555555555555") =>
	`<!-- preview-deploy:web -->\n- **web** — Stage \`pr-9\` → ${url} <sub>(${sha})</sub> <!-- d1:${db} -->`;

const stickyComment = (...blocks: string[]) =>
	`<!-- preview-deploy -->\n### 🚀 Preview deployed\n${blocks.join("\n")}`;

describe("resolvePreviewUrl", () => {
	it("resolves the web preview URL from the web block", () => {
		const url = "https://pr-9-web.kampusinfra.workers.dev";
		assert.strictEqual(resolvePreviewUrl(stickyComment(webBlock(url))), url);
	});

	it("returns null when the comment carries no block for the app", () => {
		assert.strictEqual(
			resolvePreviewUrl("<!-- preview-deploy -->\n### 🚀 Preview deployed\n"),
			null,
		);
		assert.strictEqual(resolvePreviewUrl(""), null);
	});

	it("keys off the :web anchor — a second app's line never shadows web (the head -n1 hazard)", () => {
		const apiUrl = "https://pr-9-api.kampusinfra.workers.dev";
		const webUrl = "https://pr-9-web.kampusinfra.workers.dev";
		// A future `api` app's block appears BEFORE web's in the comment.
		const apiBlock = `<!-- preview-deploy:api -->\n- **api** — Stage \`pr-9\` → ${apiUrl} <sub>(abc1234)</sub>`;
		const body = stickyComment(apiBlock, webBlock(webUrl));
		assert.strictEqual(resolvePreviewUrl(body), webUrl);
		assert.strictEqual(resolvePreviewUrl(body, "api"), apiUrl);
	});

	it("does not bleed a sibling app's URL into the web block", () => {
		const webUrl = "https://pr-9-web.kampusinfra.workers.dev";
		const apiUrl = "https://pr-9-api.kampusinfra.workers.dev";
		// web block first, then api — web must still resolve to its OWN url.
		const apiBlock = `<!-- preview-deploy:api -->\n- **api** — Stage \`pr-9\` → ${apiUrl} <sub>(abc1234)</sub>`;
		const body = stickyComment(webBlock(webUrl), apiBlock);
		assert.strictEqual(resolvePreviewUrl(body), webUrl);
	});
});

describe("readPreviewAnnouncement", () => {
	const url = "https://pr-9-web.kampusinfra.workers.dev";

	it("reads the app's URL and the head it deployed, out of that app's own block", () => {
		const read = readPreviewAnnouncement(stickyComment(webBlock(url, "abc1234")), "web");
		assert.deepStrictEqual(read, {
			_tag: "Announced",
			value: {app: "web", url, deployedSha: "abc1234"},
		});
	});

	it("reads the deployed head from an @-anchored or backticked announcement too", () => {
		const at = `<!-- preview-deploy:web -->\n- **web** → ${url} @ 03135b91aa04`;
		assert.deepStrictEqual(readPreviewAnnouncement(at, "web"), {
			_tag: "Announced",
			value: {app: "web", url, deployedSha: "03135b91aa04"},
		});
	});

	it("is domain-agnostic — an adopter's preview host is not workers.dev", () => {
		const elsewhere = "https://pr-9.preview.example.test";
		const body = `<!-- preview-deploy:web -->\n- **web** → ${elsewhere} <sub>(abc1234)</sub>`;
		assert.deepStrictEqual(readPreviewAnnouncement(body, "web"), {
			_tag: "Announced",
			value: {app: "web", url: elsewhere, deployedSha: "abc1234"},
		});
	});

	it("calls an unreadable block MALFORMED, never absent — unreadable is not a fact about a deploy", () => {
		const noSha = `<!-- preview-deploy:web -->\n- **web** → ${url}`;
		assert.strictEqual(readPreviewAnnouncement(noSha, "web")._tag, "Malformed");
		const noUrl = "<!-- preview-deploy:web -->\n- **web** — the deploy failed (abc1234)";
		assert.strictEqual(readPreviewAnnouncement(noUrl, "web")._tag, "Malformed");
	});

	it("does not read a hex-looking path segment inside the URL as the deployed head", () => {
		const hexPath = "https://deadbeef1.preview.example.test/x";
		const body = `<!-- preview-deploy:web -->\n- **web** → ${hexPath}`;
		assert.strictEqual(readPreviewAnnouncement(body, "web")._tag, "Malformed");
	});

	it("says NoApp for an announcement that carries no block for the app asked about", () => {
		assert.deepStrictEqual(readPreviewAnnouncement(stickyComment(webBlock(url)), "api"), {
			_tag: "NoApp",
		});
	});
});

describe("announcedApps / isPreviewAnnouncement", () => {
	it("names every app the announcement carries, in comment order, once each", () => {
		const apiBlock = "<!-- preview-deploy:api -->\n- **api** → https://a.test (abc1234)";
		const webBody = webBlock("https://w.test");
		assert.deepStrictEqual(announcedApps(stickyComment(apiBlock, webBody)), ["api", "web"]);
	});

	it("recognizes an announcement by its anchor, and nothing else as one", () => {
		assert.isTrue(isPreviewAnnouncement(stickyComment(webBlock("https://w.test"))));
		assert.isFalse(isPreviewAnnouncement("a review comment mentioning preview deploys"));
	});
});
