/**
 * The preview-URL resolver — keyed off the per-app `<!-- preview-deploy:<app> -->`
 * anchor from the sticky preview-deploy comment (deploy.yml / ci.yml `webRe`).
 * The load-bearing case is multi-app: resolution must NOT return the first
 * `workers.dev` URL in the comment, or a second app's line would shadow web's.
 */
import {assert, describe, it} from "@effect/vitest";
import {resolvePreviewUrl} from "./resolve.ts";

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
