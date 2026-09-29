import {assert, describe, it} from "@effect/vitest";
import type {CommentRecord} from "../io/issues.ts";
import {resolvePreview} from "./preview.ts";

const comment = (id: number, body: string, updatedAt = "2026-08-09T00:00:00Z"): CommentRecord => ({
	id,
	author: "kampus-bot",
	createdAt: "2026-08-08T00:00:00Z",
	updatedAt,
	body,
});

const block = (app: string, url: string, sha: string) =>
	`<!-- preview-deploy:${app} -->\n- **${app}** — Stage \`pr-9\` → ${url} <sub>(${sha})</sub>`;

const WEB = "https://pr-9-web.example.test";
const HEAD = "abc1234def5678901234567890abcdef12345678";
const EARLIER = "9fd5949747856d37a3604d628b5c16156b060fe8";

/** The body `.github/workflows/deploy.yml`'s no-preview job posts, byte for byte. */
const noPreview = (headSha: string) =>
	"<!-- preview-deploy -->\n### No preview deploy\n" +
	`<!-- preview-deploy:none head:${headSha} -->\n` +
	"- No preview deploy for this PR — its diff touches no deploy-relevant path, " +
	"so no preview stack was minted and `e2e` is not applicable. " +
	`<sub>(${headSha.slice(0, 7)})</sub>`;

describe("resolvePreview", () => {
	it("resolves the sole app when the caller named none", () => {
		const resolution = resolvePreview([comment(1, block("web", WEB, "abc1234"))], null, HEAD);
		assert.deepStrictEqual(resolution, {
			_tag: "Resolved",
			value: {app: "web", url: WEB, deployedSha: "abc1234"},
			apps: ["web"],
		});
	});

	it("refuses to guess between apps — ambiguity is the caller's to settle", () => {
		const body = `${block("api", "https://api.example.test", "abc1234")}\n${block("web", WEB, "abc1234")}`;
		assert.deepStrictEqual(resolvePreview([comment(1, body)], null, HEAD), {
			_tag: "Ambiguous",
			apps: ["api", "web"],
		});
		assert.deepStrictEqual(resolvePreview([comment(1, body)], "web", HEAD), {
			_tag: "Resolved",
			value: {app: "web", url: WEB, deployedSha: "abc1234"},
			// Every app the announcement carries, not the chosen one alone: a caller shooting a surface
			// has to know which apps were deployed at all.
			apps: ["api", "web"],
		});
	});

	it("proves NoPreview only when nothing carries the anchor", () => {
		assert.deepStrictEqual(resolvePreview([comment(1, "looks fine to me")], null, HEAD), {
			_tag: "NoPreview",
			markedAt: null,
		});
	});

	it("calls an app the announcement does not carry MALFORMED, not NoPreview", () => {
		const resolution = resolvePreview([comment(1, block("web", WEB, "abc1234"))], "api", HEAD);
		assert.strictEqual(resolution._tag, "Malformed");
	});

	it("picks the NEWEST announcement by write stamp, not by list order", () => {
		const older = comment(
			1,
			block("web", "https://old.example.test", "1111111"),
			"2026-08-01T00:00:00Z",
		);
		const newer = comment(2, block("web", WEB, "abc1234"), "2026-08-09T10:00:00Z");
		assert.deepStrictEqual(resolvePreview([newer, older], null, HEAD), {
			_tag: "Resolved",
			value: {app: "web", url: WEB, deployedSha: "abc1234"},
			apps: ["web"],
		});
	});

	it("proves NoPreview from the workflow's no-preview marker naming the head", () => {
		assert.deepStrictEqual(resolvePreview([comment(1, noPreview(HEAD))], null, HEAD), {
			_tag: "NoPreview",
			markedAt: HEAD,
		});
		assert.deepStrictEqual(resolvePreview([comment(1, noPreview(HEAD))], "web", "abc1234"), {
			_tag: "NoPreview",
			markedAt: HEAD,
		});
	});

	it("keeps a no-preview marker for another head MALFORMED — absence at an earlier push is not absence now", () => {
		const resolution = resolvePreview([comment(1, noPreview(EARLIER))], null, HEAD);
		assert.strictEqual(resolution._tag, "Malformed");
	});

	it("reads whichever of a deploy and a no-preview marker is newer", () => {
		const deploy = comment(2, block("web", WEB, "abc1234"), "2026-08-09T10:00:00Z");
		const olderMarker = comment(1, noPreview(HEAD), "2026-08-01T00:00:00Z");
		assert.strictEqual(resolvePreview([olderMarker, deploy], null, HEAD)._tag, "Resolved");
		const newerMarker = comment(1, noPreview(HEAD), "2026-08-10T00:00:00Z");
		assert.strictEqual(resolvePreview([newerMarker, deploy], null, HEAD)._tag, "NoPreview");
	});

	it("calls a no-preview marker beside app blocks MALFORMED", () => {
		const body = `${noPreview(HEAD)}\n${block("web", WEB, "abc1234")}`;
		assert.strictEqual(resolvePreview([comment(1, body)], null, HEAD)._tag, "Malformed");
	});
});
