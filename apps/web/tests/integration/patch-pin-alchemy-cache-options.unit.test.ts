// @patch-pin: alchemy@2.0.0-beta.59
/**
 * Behavior-pin for the Workers-cache hunk of `patches/alchemy@2.0.0-beta.59.patch`
 * (ADR 0038 + ADR 0170). beta.59 predates alchemy's native per-Worker cache knob,
 * so the patch adds a `cache?: { enabled?: boolean }` prop to `WorkerProps`
 * (`lib/Cloudflare/Workers/Worker.d.ts`) and threads it through `WorkerProvider`
 * (`lib/Cloudflare/Workers/WorkerProvider.js`) as the script-upload metadata's
 * `cache_options` field via the mapping `cache_options: news.cache` — sent only
 * when set, so an unpatched-shaped resource (no `cache`) emits no `cache_options`.
 *
 * The provider mapping lives deep inside `LiveWorkerProvider`'s `Effect.gen`
 * closure (the metadata object at construction time), not a pure export, so it is
 * unreachable for a pure characterization call. This pin therefore does two things:
 *
 *   1. GROUND — read the real patched artifact off the installed `alchemy` package
 *      and assert the `cache_options: news.cache` threading and the `cache?` prop
 *      are present. If a future `pnpm install` drops or rewrites the hunk (a lost
 *      patch, a native-knob upgrade), these reds — the pin's teeth.
 *   2. CONTRACT — model the `news.cache -> cache_options` mapping the artifact
 *      encodes and assert the prop-threading contract on both branches: `cache`
 *      set threads through, `cache` unset leaves `cache_options` undefined and
 *      drops off the wire under JSON serialization (no accidental emission).
 *
 * Retire this file when a future alchemy release ships the field natively and the
 * patch hunk is removed.
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
			// The exact mapping the upload metadata carries. Reds if the threading
			// line is removed or renamed — acceptance criterion #3.
			expect(providerSrc).toContain("cache_options: news.cache");
		});

		it("WorkerProps declares the `cache?: { enabled?: boolean }` prop", () => {
			expect(propsDts).toMatch(/cache\?:\s*\{\s*enabled\?:\s*boolean;?\s*\}/);
		});
	});

	describe("contract — the news.cache -> cache_options mapping", () => {
		// A faithful model of the artifact's single threading line
		// (`cache_options: news.cache`): the upload metadata's `cache_options`
		// field IS the resource's `cache` prop, verbatim, whatever its shape.
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
