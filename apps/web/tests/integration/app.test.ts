/**
 * Compiled HTTP surface — black-box over the deployed worker (ADR 0027, ADR 0082).
 *
 * Scope is only the route wiring NO other integration file exercises: the RSS feed and the
 * server-side flag-evaluation seam (#510). `/api/health`, the `/fate` seam, the `me` round-trip
 * and `/fate/live` are proven in their own files and are deliberately not duplicated here.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1
 * is shared with every migrated file. It isolates by NS: the email + post title it seeds
 * are `${NS}-…` prefixed, and the RSS assertion that reads the (now-shared) global feed
 * checks only id/title-membership of its OWN seeded post (its NS-prefixed title is present)
 * — never an exact item set, which another file's posts would now break. The structural
 * RSS test and the flag-evaluation seam seed nothing and read fixed routes.
 */
import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

describe("RSS feed — /rss.xml over the deployed worker", () => {
	it("returns well-formed RSS 2.0 with the feed's own self-link", async () => {
		const res = await h.req("/rss.xml");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/application\/rss\+xml/);
		const body = await res.text();
		expect(body).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
		expect(body).toContain('<rss version="2.0"');
		expect(body).toContain("<channel>");
		expect(body).toContain("</channel></rss>");
		expect(body).toContain('rel="self"');
	});

	it("lists a submitted post with an absolute /pano link + pubDate", async () => {
		const author = await h.signUpYazar(`${NS}-rss@test.local`, "hunter2hunter2", "rss");
		const title = `${NS} rss feed test post`;
		const submit = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title, tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(submit.ok).toBe(true);

		const res = await h.req("/rss.xml");
		const body = await res.text();
		expect(body).toContain(`<title>${title}</title>`);
		expect(body).toMatch(/<link>https?:\/\/[^<]+\/pano\/[^<]+<\/link>/);
		expect(body).toMatch(/<pubDate>[^<]+GMT<\/pubDate>/);
	});
});

describe("server-side flag evaluation — /api/flags/* over the deployed worker (#510)", () => {
	it("GET /api/flags/probe reads a flag through Flags and takes the safe-off branch", async () => {
		// No flag is declared, so the dark-ship read returns the default (`false`) and the safe/off
		// branch is taken.
		const res = await h.req("/api/flags/probe");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {flag: string; enabled: boolean; branch: string};
		expect(body.enabled).toBe(false);
		expect(body.branch).toBe("off");
	});

	it("POST /api/flags/evaluate returns server-evaluated values per requested key", async () => {
		// Undeclared flags resolve to each call's OWN default — the safe-default contract.
		const res = await h.json("/api/flags/evaluate", {
			keys: [
				{key: "new-ui", default: false},
				{key: "legacy-on", default: true},
			],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {flags: Record<string, boolean>};
		expect(body.flags).toEqual({"new-ui": false, "legacy-on": true});
	});

	it("POST /api/flags/evaluate degrades safe on a malformed body — {flags:{}}", async () => {
		const res = await h.req("/api/flags/evaluate", {
			method: "POST",
			headers: {"content-type": "application/json", origin: "http://localhost:3000"},
			body: "not json",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {flags: Record<string, boolean>};
		// No keys parsed → empty result → the client stays at its in-code defaults.
		expect(body.flags).toEqual({});
	});
});
