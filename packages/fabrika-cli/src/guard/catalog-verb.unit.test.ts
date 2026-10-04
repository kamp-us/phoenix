/**
 * `guard catalog-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem — the
 * `gate.unit.test.ts` cases from the v1 CLI, re-seated on the three guard exit codes.
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
				{name: "acme", devDependencies: {turbo: "catalog:"}},
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

	it("reds a member that pins a hardcoded version, with nothing on stdout", async () => {
		const outcome = await run(repo({name: "acme"}, {a: {dependencies: {bar: "^1.2.3"}}}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("packages/a/package.json");
		expect(outcome.stderr.join("\n")).toContain("breaks frozen-lockfile CI");
	});

	it("reds the ROOT manifest too — the catalog rule governs it as well", async () => {
		const outcome = await run(
			repo(
				{name: "acme", devDependencies: {turbo: "^2.0.0"}},
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
				fakeFs(repo({name: "acme"}, {a: {dependencies: {bar: "^1.2.3"}}})).layer,
			),
		);
		expect(outcome.code).toBe(0);
	});

	it("annotates the offending dep line under Actions", async () => {
		const outcome = await run(repo({name: "acme"}, {a: {dependencies: {bar: "^1.2.3"}}}), {
			GITHUB_ACTIONS: "true",
		});
		expect(
			outcome.stderr.some((line) => line.startsWith("::error file=packages/a/package.json,line=")),
		).toBe(true);
	});

	// The fail-closed floor: no manifest in scope means the guard proved nothing, so it reds.
	it("fails closed when zero manifests are in scope", async () => {
		const outcome = await run(repo(null, {dead: null}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO");
	});

	// Read fine, judged nothing: a manifest that will not parse is UNKNOWN, never clean.
	it("answers UNKNOWN on a manifest that does not parse", async () => {
		const outcome = await run(repo({name: "acme"}, {a: "{not json"}));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("packages/a/package.json");
	});

	it("answers UNKNOWN when a manifest cannot be read", async () => {
		const options = repo({name: "acme"}, {a: {dependencies: {react: "catalog:"}}});
		const outcome = await run({...options, unreadable: [`${ROOT}/packages/a/package.json`]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when pnpm-workspace.yaml cannot be read", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("pnpm-workspace.yaml");
	});

	describe("the catalogGuard key", () => {
		const CONFIG = `${ROOT}/.fabrika.jsonc`;
		/** A tree that reds under the rule: the root and a member both pin hardcoded versions. */
		const pinned = repo(
			{name: "acme", devDependencies: {turbo: "^2.0.0"}},
			{a: {dependencies: {bar: "^1.2.3"}}},
		);
		const declaring = (config: string, base: FakeFsOptions = pinned): FakeFsOptions => ({
			...base,
			files: {...base.files, [CONFIG]: config},
		});

		it("judges no manifest when the repo declares it off, and exits 0 saying so", async () => {
			const outcome = await run(declaring('{"catalogGuard": "off"}'));
			expect(outcome.code).toBe(0);
			expect(outcome.stdout).toBe(
				'guard catalog-guard check: turned off by "catalogGuard": "off" in .fabrika.jsonc — no manifest was judged, so this is not a pass.\n',
			);
			expect(outcome.stderr).toEqual([]);
			expect(outcome.turnedOff).toBe('"catalogGuard": "off" in .fabrika.jsonc');
		});

		// Reading a manifest here would answer UNKNOWN, and scanning for one would answer zero scope.
		it("opens no manifest and no workspace file when it is off", async () => {
			const unreadable = await run({
				...declaring('{"catalogGuard": "off"}'),
				unreadable: [`${ROOT}/package.json`, `${ROOT}/packages/a/package.json`, WORKSPACE],
			});
			expect(unreadable.code).toBe(0);
			const empty = await run({files: {[CONFIG]: '{"catalogGuard": "off"}'}});
			expect(empty.code).toBe(0);
		});

		it.each([
			["declared on", declaring('{"catalogGuard": "on"}')],
			["left out of the config", declaring("{}")],
			["with no config file at all", pinned],
		])("judges the same manifests and reds the same way when %s", async (_case, options) => {
			const outcome = await run(options);
			expect(outcome.code).toBe(VIOLATION);
			expect(outcome.turnedOff).toBeUndefined();
			const report = outcome.stderr.join("\n");
			expect(report).toContain("2 dependencies pin a hardcoded version");
			expect(report).toContain("of 2 manifests scanned");
			expect(report).toContain("package.json: devDependencies `turbo` pins `^2.0.0`");
			expect(report).toContain("packages/a/package.json: dependencies `bar` pins `^1.2.3`");
		});

		it("still passes a clean tree when declared on", async () => {
			const outcome = await run(
				declaring(
					'{"catalogGuard": "on"}',
					repo({name: "acme"}, {a: {dependencies: {react: "catalog:"}}}),
				),
			);
			expect(outcome.code).toBe(0);
			expect(outcome.turnedOff).toBeUndefined();
			expect(outcome.stdout).toContain("all deps in 2 workspace manifests");
		});

		it.each([
			["a value outside on and off", declaring('{"catalogGuard": false}')],
			["a config that does not parse", declaring("{not json")],
			["a config nobody could read", {...declaring("{}"), unreadable: [CONFIG]}],
		])("answers UNKNOWN, never off, on %s", async (_case, options) => {
			const outcome = await run(options);
			expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
			expect(outcome.stdout).toBe("");
			expect(outcome.turnedOff).toBeUndefined();
			expect(outcome.stderr.join("\n")).toContain(
				"cannot tell whether this repo turned the guard off",
			);
		});

		it.each([
			["a violation", pinned, VIOLATION],
			["zero scope", repo(null, {dead: null}), ZERO_SCOPE],
			[
				"a manifest that does not parse",
				repo({name: "acme"}, {a: "{not json"}),
				PRECONDITION_UNKNOWN,
			],
			["a malformed key", declaring('{"catalogGuard": "nope"}'), PRECONDITION_UNKNOWN],
			["an unreadable workspace file", {files: {}}, PRECONDITION_UNKNOWN],
		])("states the rule and names the key on every red — %s", async (_case, options, code) => {
			const outcome = await run(options);
			expect(outcome.code).toBe(code);
			const report = outcome.stderr.join("\n");
			expect(report).toContain("The rule: every dependency in a workspace package.json");
			expect(report).toContain("This repo may simply not use a pnpm catalog.");
			expect(report).toContain('set "catalogGuard": "off" in .fabrika.jsonc');
		});

		it("names the key on each annotation under Actions", async () => {
			const outcome = await run(pinned, {GITHUB_ACTIONS: "true"});
			const annotations = outcome.stderr.filter((line) => line.startsWith("::error"));
			expect(annotations).toHaveLength(2);
			for (const line of annotations) expect(line).toContain("catalogGuard");
		});
	});

	it("names the key when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runCatalogGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.stderr.join("\n")).toContain("catalogGuard");
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
