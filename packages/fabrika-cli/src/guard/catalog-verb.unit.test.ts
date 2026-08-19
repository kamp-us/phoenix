/**
 * `guard catalog-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem — the
 * `gate.unit.test.ts` cases from `pipeline-cli`, re-seated on the three guard exit codes.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {runCatalogGuard} from "./catalog-verb.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";

const ROOT = "/repo";
const WORKSPACE = `${ROOT}/pnpm-workspace.yaml`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runCatalogGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

/**
 * A repo whose `packages/` holds the named members. A member's value is its `package.json` — an
 * object is stringified, a raw string is written verbatim (for the unparseable cases), and `null`
 * is a dead shell with no manifest at all.
 *
 * The manifests are written INDENTED, the shape a real one has on disk: the line-locating the
 * annotation rests on needs a dep to sit on its own line, and a one-line fixture would silently
 * exercise only the file-level fallback.
 */
const repo = (
	root: Record<string, unknown> | null,
	members: Readonly<Record<string, Record<string, unknown> | string | null>>,
): FakeFsOptions => {
	const files: Record<string, string> = {[WORKSPACE]: "packages:\n  - packages/*\n"};
	if (root !== null) files[`${ROOT}/package.json`] = JSON.stringify(root, null, "\t");
	const directories = [`${ROOT}/packages`];
	for (const [name, manifest] of Object.entries(members)) {
		directories.push(`${ROOT}/packages/${name}`);
		if (manifest === null) continue;
		files[`${ROOT}/packages/${name}/package.json`] =
			typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, "\t");
	}
	return {files, dirs: {[`${ROOT}/packages`]: Object.keys(members)}, directories};
};

describe("runCatalogGuard", () => {
	it("passes when every dep across the root and its members is on catalog:/workspace:", async () => {
		const outcome = await run(
			repo(
				{name: "phoenix", devDependencies: {turbo: "catalog:"}},
				{
					a: {name: "@kampus/a", dependencies: {react: "catalog:", "@kampus/b": "workspace:*"}},
				},
			),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain(
			"all deps in 2 workspace manifests are on catalog:/workspace:",
		);
		expect(outcome.stderr).toEqual([]);
	});

	it("ignores dead-shell directories rather than redding on them", async () => {
		const outcome = await run(
			repo({name: "phoenix"}, {real: {dependencies: {react: "catalog:"}}, dead: null}),
		);
		expect(outcome.code).toBe(0);
	});

	it("reds a member that pins a hardcoded version, with nothing on stdout", async () => {
		const outcome = await run(repo({name: "phoenix"}, {a: {dependencies: {bar: "^1.2.3"}}}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("packages/a/package.json");
		expect(outcome.stderr.join("\n")).toContain("#535");
	});

	it("reds the ROOT manifest too — the catalog rule governs it as well", async () => {
		const outcome = await run(
			repo(
				{name: "phoenix", devDependencies: {turbo: "^2.0.0"}},
				{
					a: {dependencies: {react: "catalog:"}},
				},
			),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("package.json: devDependencies `turbo`");
	});

	it("passes a hardcoded dep supplied through the allowlist", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCatalogGuard({
					root: ROOT,
					cwd: ROOT,
					env: {},
					allowlist: [{name: "bar", reason: "unavoidable"}],
				}),
				fakeFs(repo({name: "phoenix"}, {a: {dependencies: {bar: "^1.2.3"}}})).layer,
			),
		);
		expect(outcome.code).toBe(0);
	});

	it("annotates the offending dep line under Actions", async () => {
		const outcome = await run(repo({name: "phoenix"}, {a: {dependencies: {bar: "^1.2.3"}}}), {
			GITHUB_ACTIONS: "true",
		});
		expect(
			outcome.stderr.some((line) => line.startsWith("::error file=packages/a/package.json,line=")),
		).toBe(true);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(repo({name: "phoenix"}, {a: {dependencies: {bar: "^1.2.3"}}}));
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// ADR 0092's floor: no manifest in scope means the guard proved nothing, so it reds.
	it("fails closed when zero manifests are in scope", async () => {
		const outcome = await run(repo(null, {dead: null}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO");
	});

	// Read fine, judged nothing: a manifest that will not parse is UNKNOWN, never clean.
	it("answers UNKNOWN on a manifest that does not parse", async () => {
		const outcome = await run(repo({name: "phoenix"}, {a: "{not json"}));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("packages/a/package.json");
	});

	it("answers UNKNOWN when a manifest cannot be read", async () => {
		const options = repo({name: "phoenix"}, {a: {dependencies: {react: "catalog:"}}});
		const outcome = await run({...options, unreadable: [`${ROOT}/packages/a/package.json`]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when pnpm-workspace.yaml cannot be read", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("pnpm-workspace.yaml");
	});

	it("answers UNKNOWN when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCatalogGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("no repo root");
	});
});
