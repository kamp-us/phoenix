/**
 * The lockstep guard for the worker-owned path set (#861). `app.ts` merges the
 * route layers; `index.ts` derives `runWorkerFirst` from the same manifest. These
 * tests pin that the derived globs actually cover every worker-owned mount path —
 * so a future route added without a matching glob fails CI here, not as the
 * fail-quiet "SPA shell served on GET" symptom in production.
 */
import {describe, expect, it} from "vitest";
import {globMatches, rawWorkerRoutes, typedWorkerPaths, workerFirstGlobs} from "./worker-routes.ts";

describe("globMatches", () => {
	it("matches an exact (non-wildcard) glob only on equality", () => {
		expect(globMatches("/fate", "/fate")).toBe(true);
		expect(globMatches("/fate", "/fate/live")).toBe(false);
		expect(globMatches("/rss.xml", "/rss.xml")).toBe(true);
		expect(globMatches("/rss.xml", "/rss")).toBe(false);
	});

	it("matches a trailing /* glob on the prefix and anything under it", () => {
		expect(globMatches("/api/*", "/api")).toBe(true);
		expect(globMatches("/api/*", "/api/auth/*")).toBe(true);
		expect(globMatches("/api/*", "/api/flags/probe")).toBe(true);
		expect(globMatches("/fate/*", "/fate/live")).toBe(true);
	});

	it("does not let a /* glob leak past its prefix boundary", () => {
		// `/api*` would match `/apiX`; `/api/*` must not.
		expect(globMatches("/api/*", "/apidocs")).toBe(false);
		expect(globMatches("/fate/*", "/fated")).toBe(false);
	});
});

describe("worker-owned path set is in lockstep with runWorkerFirst", () => {
	it("every raw route's mount path is covered by a derived runWorkerFirst glob", () => {
		for (const {path} of rawWorkerRoutes) {
			const covered = workerFirstGlobs.some((glob) => globMatches(glob, path));
			expect(covered, `no runWorkerFirst glob matches route path ${path}`).toBe(true);
		}
	});

	it("every typed (HttpApi) worker path is covered by a derived glob", () => {
		for (const path of typedWorkerPaths) {
			const covered = workerFirstGlobs.some((glob) => globMatches(glob, path));
			expect(covered, `no runWorkerFirst glob matches typed path ${path}`).toBe(true);
		}
	});

	it("has no dead glob — every derived glob covers at least one declared path", () => {
		const allPaths = [...rawWorkerRoutes.map((r) => r.path), ...typedWorkerPaths];
		for (const glob of workerFirstGlobs) {
			const used = allPaths.some((path) => globMatches(glob, path));
			expect(used, `runWorkerFirst glob ${glob} matches no worker-owned path`).toBe(true);
		}
	});

	it("derives runWorkerFirst as the deduplicated glob set", () => {
		expect([...workerFirstGlobs].sort()).toEqual(["/api/*", "/fate", "/fate/*", "/rss.xml"]);
		expect(new Set(workerFirstGlobs).size).toBe(workerFirstGlobs.length);
	});
});
