/**
 * The §CP enforcement core's import-closure check (ADR 0218, AC "transitively import-closed").
 *
 * The core is a set of PATHS, but an unreviewed edit reaches a gate through any module the core
 * IMPORTS — so a path list that isn't import-closed silently leaks the enforcement surface. Prose
 * closure rots on the next `import` added; this walks the graph instead.
 *
 * Three non-obvious rules make the walk meaningful:
 *
 *  - **The matcher must see DYNAMIC `import()`.** `registry.ts` wires every tool lazily
 *    (`tool("verdict", () => import("./tools/verdict/command.ts"))`, #4008) — 73 such specifiers.
 *    A static-only `(?:from|import)\s+"…"` pattern cannot match `import(` at all (the `\s+`
 *    requires whitespace), so it saw 2 edges there and the walk was blind to every dynamic import
 *    in the package. A core module that adds `import("./tools/<non-core>/x.ts")` would then be a
 *    silent escape with this test still green — the exact under-report a mechanized check exists
 *    to prevent, on the surface that IS the evidence this narrowing is safe.
 *  - **The registration fan-out is pruned as an EDGE, not a node.** Following it pulls in the whole
 *    package (250 visited / 212 escapes with no sink at all) and the check degenerates to
 *    "everything is core" — which proves nothing. The fan-out is a *listing* edge, not a
 *    *behavioral* one: the gate tools do not run through their siblings' commands. Cutting only
 *    that one edge out of `registry.ts` — while still following its every other edge — is what
 *    makes the closure tractable without over-pruning.
 *  - **The core is derived from `CONTROL_PLANE_RE`, never re-listed here.** A second copy of the
 *    path list is exactly the drift #2761 exists to prevent.
 *
 * The allowlist below is the ruled boundary's known, bounded residue — not an argument that those
 * modules are unreachable. Its point is that the set cannot GROW without this test reddening.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

const PKG_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(PKG_ROOT, "src");
/** Repo-relative, the form `CONTROL_PLANE_RE` matches against. */
const repoPath = (abs: string): string => `packages/pipeline-cli/${relative(PKG_ROOT, abs)}`;

const CP = new RegExp(CONTROL_PLANE_RE);
const isCore = (abs: string): boolean => CP.test(repoPath(abs));

const isSource = (f: string): boolean =>
	f.endsWith(".ts") && !/\.(unit\.test|test|hook\.test)\.ts$/.test(f);

const walkFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		return statSync(p).isDirectory() ? walkFiles(p) : isSource(entry) ? [p] : [];
	});

const REGISTRY = join(SRC, "registry.ts");
const TOOL_COMMAND = /^packages\/pipeline-cli\/src\/tools\/[^/]+\/command\.ts$/;

/**
 * `registry.ts`'s tool-registration fan-out — a listing edge, not a behavioral one. Scoped to the
 * EDGE (this one fan-out out of this one module), never to the node: every other edge out of
 * `registry.ts` is still followed, so the prune cannot hide a real dependency. See the docblock.
 */
const isSunkEdge = (from: string, dep: string): boolean =>
	from === REGISTRY && TOOL_COMMAND.test(repoPath(dep));

/** Static `from "…"` / bare `import "…"`. Both quote styles, so a lint-rule change can't blind it. */
const STATIC_IMPORT = /(?:from|import)\s+["'](\.[^"']+)["']/g;
/** Dynamic `import("…")` / `require("…")` — the form the registry actually uses. See the docblock. */
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*["'](\.[^"']+)["']/g;

const isFile = (p: string): boolean => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/**
 * Resolve a relative specifier the way the runtime does: exact path, then `.ts`, then `/index.ts`.
 * An unresolvable specifier THROWS rather than being skipped — a silently-dropped edge is a silent
 * escape, which is the failure mode this whole check exists to make impossible.
 */
const resolveSpec = (from: string, spec: string): string => {
	const base = resolve(dirname(from), spec);
	for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
		if (isFile(candidate)) return candidate;
	}
	throw new Error(`unresolvable relative import "${spec}" from ${repoPath(from)}`);
};

const importsOf = (abs: string): string[] => {
	const text = readFileSync(abs, "utf8");
	const out: string[] = [];
	for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
		for (const m of text.matchAll(pattern)) {
			const spec = m[1];
			if (spec !== undefined) out.push(resolveSpec(abs, spec));
		}
	}
	return out;
};

/** Every in-package module reachable from the retained core, minus the core itself. */
const escapingModules = (): ReadonlyArray<string> => {
	const seeds = walkFiles(SRC).filter(isCore);
	const seen = new Set<string>(seeds);
	const queue = [...seeds];
	const escaped = new Set<string>();
	while (queue.length > 0) {
		const cur = queue.pop() as string;
		for (const dep of importsOf(cur)) {
			if (isSunkEdge(cur, dep)) continue;
			if (seen.has(dep)) continue;
			seen.add(dep);
			if (!isCore(dep)) escaped.add(repoPath(dep));
			queue.push(dep);
		}
	}
	return [...escaped].sort();
};

/**
 * The ruled residue: modules the retained core imports that the ruled thirteen-path core does not
 * retain. Each is recorded in ADR 0218 with its reachability — this is a pin, not an absolution.
 * `tracker/gh-io.ts` left this list when it was promoted INTO the core; it has no relative imports
 * of its own, so promoting it pulled nothing new in.
 */
const ALLOWED_ESCAPES = [
	// `src/version.ts` reads the package manifest for its version rather than declaring a literal
	// (#5714). Pinned rather than filtered out of the walk: a JSON edge out of the core is still an
	// edge worth reddening on, so the next one has to be argued for too — this is the package's own
	// manifest, which carries no behavior a gate could reach through.
	"packages/pipeline-cli/package.json",
	"packages/pipeline-cli/src/tools/guard-content-probe/guard-content-probe.ts",
	"packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts",
	"packages/pipeline-cli/src/tools/leak-guard/path-matcher.ts",
];

describe("the §CP enforcement core's import closure (ADR 0218)", () => {
	it("seeds a non-empty core (zero scope would make the check vacuous — ADR 0092)", () => {
		expect(walkFiles(SRC).filter(isCore).length).toBeGreaterThan(0);
	});

	it("sees DYNAMIC import() edges — a static-only matcher silently under-reports", () => {
		const fanout = importsOf(REGISTRY)
			.map(repoPath)
			.filter((d) => TOOL_COMMAND.test(d));
		expect(fanout.length).toBeGreaterThan(50);
	});

	it("prunes the registration fan-out as an EDGE, not as a node", () => {
		// `registry.ts`'s non-fan-out edges are still followed: `tool-registration.ts` is reached
		// THROUGH it, so a node-scoped sink would have cut a real dependency along with the listing one.
		expect(importsOf(REGISTRY).map(repoPath)).toContain(
			"packages/pipeline-cli/src/tool-registration.ts",
		);
		expect(isSunkEdge(REGISTRY, join(SRC, "tool-registration.ts"))).toBe(false);
		expect(isSunkEdge(REGISTRY, join(SRC, "tools/verdict/command.ts"))).toBe(true);
	});

	it("reaches exactly the recorded residue — a NEW unclosed import reds this", () => {
		expect(escapingModules()).toEqual(ALLOWED_ESCAPES);
	});

	it("keeps the src/ root modules INSIDE the core (the (b) closure fix)", () => {
		for (const m of ["read-stdin.ts", "read-stdin-core.ts", "annotate.ts", "find-root-dir.ts"]) {
			expect(escapingModules()).not.toContain(`packages/pipeline-cli/src/${m}`);
		}
	});

	it("no longer escapes through tracker/gh-io.ts — the ADR-0055 ACL is IN the core", () => {
		expect(escapingModules()).not.toContain("packages/pipeline-cli/src/tools/tracker/gh-io.ts");
	});
});
