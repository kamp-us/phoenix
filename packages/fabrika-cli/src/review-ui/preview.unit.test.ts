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

describe("resolvePreview", () => {
	it("resolves the sole app when the caller named none", () => {
		const resolution = resolvePreview([comment(1, block("web", WEB, "abc1234"))], null);
		assert.deepStrictEqual(resolution, {
			_tag: "Resolved",
			value: {app: "web", url: WEB, deployedSha: "abc1234"},
		});
	});

	it("refuses to guess between apps — ambiguity is the caller's to settle", () => {
		const body = `${block("api", "https://api.example.test", "abc1234")}\n${block("web", WEB, "abc1234")}`;
		assert.deepStrictEqual(resolvePreview([comment(1, body)], null), {
			_tag: "Ambiguous",
			apps: ["api", "web"],
		});
		assert.deepStrictEqual(resolvePreview([comment(1, body)], "web"), {
			_tag: "Resolved",
			value: {app: "web", url: WEB, deployedSha: "abc1234"},
		});
	});

	it("proves NoPreview only when nothing carries the anchor", () => {
		assert.deepStrictEqual(resolvePreview([comment(1, "looks fine to me")], null), {
			_tag: "NoPreview",
		});
	});

	it("calls an app the announcement does not carry MALFORMED, not NoPreview", () => {
		const resolution = resolvePreview([comment(1, block("web", WEB, "abc1234"))], "api");
		assert.strictEqual(resolution._tag, "Malformed");
	});

	it("picks the NEWEST announcement by write stamp, not by list order", () => {
		const older = comment(
			1,
			block("web", "https://old.example.test", "1111111"),
			"2026-08-01T00:00:00Z",
		);
		const newer = comment(2, block("web", WEB, "abc1234"), "2026-08-09T10:00:00Z");
		assert.deepStrictEqual(resolvePreview([newer, older], null), {
			_tag: "Resolved",
			value: {app: "web", url: WEB, deployedSha: "abc1234"},
		});
	});
});
