// @patch-pin: alchemy@2.0.0-beta.59
/**
 * Behavior-pin for the Workers-cache hunk of `patches/alchemy@2.0.0-beta.59.patch`
 * (ADR 0038 + ADR 0170) — beta.59 predates alchemy's native per-Worker cache knob.
 *
 * The patched mapping lives inside `LiveWorkerProvider`'s `Effect.gen` closure, not
 * a pure export, so it can't be called directly. Hence two halves: GROUND reads the
 * installed artifact's text so a `pnpm install` that drops or rewrites the hunk
 * reds (the pin's teeth), and CONTRACT models the same mapping to assert both
 * branches.
 *
 * Retire this file when an alchemy release ships the field natively.
 */
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

// The patched sources sit next to `alchemy/Cloudflare`'s entry (`lib/Cloudflare/
// index.js`). Resolving that real export and walking to the sibling `Workers/`
// dir is patch-hash-agnostic — it follows pnpm's install layout, not a pinned path.
const cloudflareEntry = fileURLToPath(import.meta.resolve("alchemy/Cloudflare"));
const workersDir = path.join(path.dirname(cloudflareEntry), "Workers");
const providerSrc = fs.readFileSync(path.join(workersDir, "WorkerProvider.js"), "utf8");
const propsDts = fs.readFileSync(path.join(workersDir, "Worker.d.ts"), "utf8");

describe("patch-pin: alchemy cache.enabled -> cache_options (ADR 0170)", () => {
	describe("grounding — the installed artifact carries the hunk", () => {
		it("WorkerProvider threads the resource `cache` prop as `cache_options`", () => {
			expect(providerSrc).toContain("cache_options: news.cache");
		});

		it("WorkerProps declares the `cache?: { enabled?: boolean }` prop", () => {
			expect(propsDts).toMatch(/cache\?:\s*\{\s*enabled\?:\s*boolean;?\s*\}/);
		});
	});

	describe("contract — the news.cache -> cache_options mapping", () => {
		// A faithful model of the artifact's single threading line,
		// `cache_options: news.cache` — verbatim, whatever the prop's shape.
		const threadCacheOptions = (news: {cache?: {enabled?: boolean}}) => ({
			cache_options: news.cache,
		});

		it("threads `cache: { enabled: true }` to `cache_options: { enabled: true }`", () => {
			const metadata = threadCacheOptions({cache: {enabled: true}});
			expect(metadata.cache_options).toEqual({enabled: true});
		});

		it("threads `cache: { enabled: false }` through unchanged", () => {
			const metadata = threadCacheOptions({cache: {enabled: false}});
			expect(metadata.cache_options).toEqual({enabled: false});
		});

		it("emits no `cache_options` when the resource has no `cache` prop", () => {
			const metadata = threadCacheOptions({});
			expect(metadata.cache_options).toBeUndefined();
			// "Sent only when set": an undefined field drops out of the JSON body
			// on the wire, so an unpatched-shaped resource's upload is untouched.
			expect(JSON.parse(JSON.stringify(metadata))).not.toHaveProperty("cache_options");
		});
	});
});
