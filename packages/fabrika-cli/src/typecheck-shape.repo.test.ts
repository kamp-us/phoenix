/**
 * The repo-shape pin behind `.patterns/typecheck-two-step.md` (#7804).
 *
 * Effect language-service diagnostics used to come from a `tsc` binary patched by a root
 * `postinstall`. That patch was state in `node_modules`, so an install that skipped scripts — every
 * agent worktree, via `lefthook.yml`'s `post-checkout` — got a compiler that dropped every
 * diagnostic and exited 0. The replacement is a second command in each package's `typecheck`
 * script, which nothing installs and nothing can silently omit except a manifest edit. This test is
 * what makes that omission red.
 *
 * It reads the live manifests rather than a fixture: the invariant is about the files that ship.
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The workspace globs `pnpm-workspace.yaml` declares, as their literal parent directories. */
const MEMBER_ROOTS = ["apps", "packages", "infra"] as const;

/** The `@effect/tsgo` bin, which must resolve from the package that invokes it. */
const TSGO_DEP = "@effect/tsgo";

/** The exact second step. `--strict` is what makes a warning-severity diagnostic exit non-zero. */
const DIAGNOSTICS_STEP = "effect-tsgo diagnostics --project tsconfig.json --strict";

interface Manifest {
	/** Repo-relative — `packages/authz/package.json`. */
	readonly path: string;
	readonly scripts: Record<string, string>;
	readonly devDependencies: Record<string, string>;
	readonly dependencies: Record<string, string>;
}

const readManifests = (): ReadonlyArray<Manifest> => {
	const found: Manifest[] = [];
	for (const root of MEMBER_ROOTS) {
		for (const entry of readdirSync(`${REPO_ROOT}${root}`, {withFileTypes: true})) {
			if (!entry.isDirectory()) continue;
			const rel = `${root}/${entry.name}/package.json`;
			let text: string;
			try {
				text = readFileSync(`${REPO_ROOT}${rel}`, "utf8");
			} catch {
				continue; // not a workspace member — a dead shell dir
			}
			const parsed = JSON.parse(text) as Partial<Manifest>;
			found.push({
				path: rel,
				scripts: parsed.scripts ?? {},
				devDependencies: parsed.devDependencies ?? {},
				dependencies: parsed.dependencies ?? {},
			});
		}
	}
	return found;
};

/** A manifest that declares a `typecheck` script, with that script lifted out of the index. */
interface Typechecker extends Manifest {
	readonly typecheck: string;
}

const typecheckers = (): ReadonlyArray<Typechecker> =>
	readManifests().flatMap((m) => {
		const typecheck = m.scripts.typecheck;
		return typeof typecheck === "string" ? [{...m, typecheck}] : [];
	});

describe("every workspace package's typecheck runs the Effect diagnostics step", () => {
	it("finds workspace members to judge (a zero scope is the silent-no-op #7804 was)", () => {
		expect(typecheckers().length).toBeGreaterThan(10);
	});

	it("ends every typecheck script on the --strict diagnostics run", () => {
		const missing = typecheckers()
			.filter((m) => !m.typecheck.includes(DIAGNOSTICS_STEP))
			.map((m) => `${m.path}: ${m.typecheck}`);
		expect(missing).toEqual([]);
	});

	it("declares @effect/tsgo in every package that invokes its bin", () => {
		const missing = typecheckers()
			.filter((m) => m.typecheck.includes("effect-tsgo"))
			.filter((m) => !(TSGO_DEP in m.devDependencies) && !(TSGO_DEP in m.dependencies))
			.map((m) => m.path);
		expect(missing).toEqual([]);
	});
});

describe("nothing reintroduces the install-time compiler patch", () => {
	it("keeps the root package.json free of a patch postinstall", () => {
		const root = JSON.parse(readFileSync(`${REPO_ROOT}package.json`, "utf8")) as Partial<Manifest>;
		expect(root.scripts?.postinstall).toBeUndefined();
	});
});
