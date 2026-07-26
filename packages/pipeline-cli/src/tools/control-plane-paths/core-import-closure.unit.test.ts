/**
 * The §CP enforcement core's import-closure check (ADR 0218, AC "transitively import-closed").
 *
 * The core is a set of PATHS, but an unreviewed edit reaches a gate through any module the core
 * IMPORTS — so a path list that isn't import-closed silently leaks the enforcement surface. Prose
 * closure rots on the next `import` added; this walks the graph instead.
 *
 * Two non-obvious rules make the walk meaningful:
 *
 *  - **`registry.ts` is a SINK.** It imports every one of the ~68 tools' `command.ts` to build
 *    `registeredTools[]`, so seeding the walk through it pulls in the whole package (246 modules)
 *    and the check degenerates to "everything is core" — which proves nothing. The registration
 *    fan-out is a *listing* edge, not a *behavioral* one: the gate tools do not run through their
 *    siblings' commands. Cutting it is what makes the closure tractable and honest.
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

/** `registry.ts`'s tool-registration fan-out — a listing edge, not a behavioral one. See the docblock. */
const SINKS = new Set([join(SRC, "registry.ts")]);

const RELATIVE_IMPORT = /(?:from|import)\s+"(\.[^"]+)"/g;

const importsOf = (abs: string): string[] => {
	const text = readFileSync(abs, "utf8");
	const out: string[] = [];
	for (const m of text.matchAll(RELATIVE_IMPORT)) {
		const spec = m[1];
		if (spec !== undefined) out.push(resolve(dirname(abs), spec));
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
		if (SINKS.has(cur)) continue;
		for (const dep of importsOf(cur)) {
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
	"packages/pipeline-cli/src/tools/guard-content-probe/guard-content-probe.ts",
	"packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts",
	"packages/pipeline-cli/src/tools/leak-guard/path-matcher.ts",
];

describe("the §CP enforcement core's import closure (ADR 0218)", () => {
	it("seeds a non-empty core (zero scope would make the check vacuous — ADR 0092)", () => {
		expect(walkFiles(SRC).filter(isCore).length).toBeGreaterThan(0);
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
