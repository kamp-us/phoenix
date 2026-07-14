/**
 * The lockstep guard for the worker-owned path set (#861). `app.ts` merges the
 * route layers; `index.ts` derives `runWorkerFirst` from the same manifest. These
 * tests pin that the derived globs actually cover every worker-owned mount path —
 * so a future route added without a matching glob fails CI here, not as the
 * fail-quiet "SPA shell served on GET" symptom in production.
 *
 * Extended for the edge-render shell route (#2929, ADR 0179): the CF spa-shell recipe
 * (`["/*", "!/assets/*"]`) is modelled by {@link runsWorkerFirst} — the positive `/*`
 * pulls every non-asset path worker-first and the `!`-exception keeps `/assets/*`
 * edge-direct — and the HTML route (`* /*`) is pinned coupled to that `!`-exception.
 */
import {describe, expect, it} from "vitest";
import {
	assetExceptionGlobs,
	globMatches,
	rawWorkerRoutes,
	runsWorkerFirst,
	typedWorkerPaths,
	workerFirstGlobs,
} from "./worker-routes.ts";

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

	it("is exception-blind — a `!`-prefixed glob never positively matches", () => {
		// `runsWorkerFirst` composes exceptions; `globMatches` alone treats `!/assets/*`
		// as a literal that matches nothing real.
		expect(globMatches("!/assets/*", "/assets/index.js")).toBe(false);
		expect(globMatches("!/assets/*", "/fate")).toBe(false);
	});
});

describe("worker-owned path set is in lockstep with runWorkerFirst", () => {
	it("every raw route's mount path runs worker-first under the derived globs", () => {
		for (const {path} of rawWorkerRoutes) {
			expect(
				runsWorkerFirst(workerFirstGlobs, path),
				`route path ${path} does not run worker-first under the derived globs`,
			).toBe(true);
		}
	});

	it("every typed (HttpApi) worker path runs worker-first under the derived globs", () => {
		for (const path of typedWorkerPaths) {
			expect(
				runsWorkerFirst(workerFirstGlobs, path),
				`typed path ${path} does not run worker-first under the derived globs`,
			).toBe(true);
		}
	});

	it("has no dead POSITIVE glob — every positive glob covers at least one declared path", () => {
		const allPaths = [...rawWorkerRoutes.map((r) => r.path), ...typedWorkerPaths];
		for (const glob of workerFirstGlobs.filter((g) => !g.startsWith("!"))) {
			const used = allPaths.some((path) => globMatches(glob, path));
			expect(used, `positive runWorkerFirst glob ${glob} matches no worker-owned path`).toBe(true);
		}
	});

	it("every `!`-exception excludes at least one asset path it is meant to keep edge-direct", () => {
		// A `!`-exception earns its place by EXCLUDING, not covering: strip `!` and assert it
		// matches a representative asset path, so a dead exception is caught too.
		for (const exception of workerFirstGlobs.filter((g) => g.startsWith("!"))) {
			expect(
				globMatches(exception.slice(1), "/assets/index-abc123.js"),
				`exception ${exception} excludes no asset path`,
			).toBe(true);
		}
	});

	it("derives runWorkerFirst as the MINIMIZED glob set — `/*` + the `!`-exception only", () => {
		// The `/*` catch-all subsumes every specific route glob, so the CF-valid config collapses
		// to just `["/*", "!/assets/*"]` (CF rejects redundant positives — #2984).
		expect([...workerFirstGlobs].sort()).toEqual(["!/assets/*", "/*"]);
		expect(new Set(workerFirstGlobs).size).toBe(workerFirstGlobs.length);
	});

	it("carries no redundant positive rule under the `/*` catch-all (CF `run_worker_first` validity)", () => {
		// CF rejects e.g. `/fate` when `/*` is present (`rule '/*' makes it redundant`, #2984). Assert
		// no positive glob is subsumed by another, so the derived config can't reintroduce that reject.
		const positives = workerFirstGlobs.filter((g) => !g.startsWith("!"));
		for (const g of positives) {
			for (const other of positives) {
				if (other === g) continue;
				const subsumed =
					other === "/*" || (other.endsWith("/*") && g.startsWith(other.slice(0, -1)));
				expect(subsumed, `positive glob ${g} is redundant under ${other}`).toBe(false);
			}
		}
	});
});

describe("edge-render shell route couples the `/*` catch-all to the `!/assets/*` exception", () => {
	it("mounts an HTML catch-all route at `/*`", () => {
		expect(rawWorkerRoutes.some((r) => r.path === "/*")).toBe(true);
	});

	it("carries the `!/assets/*` exception in both the exception list and the derived globs", () => {
		expect(assetExceptionGlobs).toContain("!/assets/*");
		expect(workerFirstGlobs).toContain("/*");
		expect(workerFirstGlobs).toContain("!/assets/*");
	});

	it("routes every non-asset path worker-first (the shell renders through the worker)", () => {
		for (const path of ["/", "/sozluk", "/pano/abc", "/favicon.ico", "/manifest.webmanifest"]) {
			expect(runsWorkerFirst(workerFirstGlobs, path), `${path} must run worker-first`).toBe(true);
		}
	});

	it("keeps the built `/assets/*` bundles edge-direct (the `!`-exception wins)", () => {
		for (const path of ["/assets/index-abc123.js", "/assets/index-def456.css"]) {
			expect(runsWorkerFirst(workerFirstGlobs, path), `${path} must stay edge-direct`).toBe(false);
		}
	});
});
