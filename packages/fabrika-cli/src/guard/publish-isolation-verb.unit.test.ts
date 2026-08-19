/**
 * `guard publish-isolation-guard check`'s IO boundary and exit taxonomy, over a scripted
 * filesystem — the `gate.unit.test.ts` cases from `pipeline-cli`, re-seated on the three guard exit
 * codes (a single non-zero there, `7`/`11`/`12` here).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runPublishIsolationGuard} from "./publish-isolation-verb.ts";

const ROOT = "/repo";
const WORKFLOW = `${ROOT}/.github/workflows/publish.yml`;
const WORKSPACE = `${ROOT}/pnpm-workspace.yaml`;

/** A publish.yml whose tag-grammar anchors declare exactly `prefixes` as published. */
const workflow = (prefixes: ReadonlyArray<string>): string =>
	[
		"name: publish",
		"jobs:",
		"  publish:",
		"    steps:",
		...prefixes.map((p) => `      - run: if [[ ! "$TAG" =~ ^${p}-v([0-9].*)$ ]]; then exit 1; fi`),
	].join("\n");

interface Repo {
	readonly prefixes?: ReadonlyArray<string>;
	/** Directory name under `packages/` → its `package.json` contents (a string stays verbatim). */
	readonly packages: Readonly<Record<string, Record<string, unknown> | string>>;
	readonly globs?: ReadonlyArray<string>;
}

const repo = (spec: Repo): FakeFsOptions => {
	const names = Object.keys(spec.packages);
	const files: Record<string, string> = {
		[WORKFLOW]: workflow(spec.prefixes ?? ["fabrika-cli"]),
		[WORKSPACE]: `packages:\n${(spec.globs ?? ["packages/*"]).map((g) => `  - ${g}`).join("\n")}\n`,
	};
	for (const [name, pkg] of Object.entries(spec.packages)) {
		files[`${ROOT}/packages/${name}/package.json`] =
			typeof pkg === "string" ? pkg : JSON.stringify(pkg);
	}
	return {
		files,
		dirs: {[`${ROOT}/packages`]: names},
		directories: [`${ROOT}/packages`, ...names.map((n) => `${ROOT}/packages/${n}`)],
	};
};

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runPublishIsolationGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

describe("runPublishIsolationGuard", () => {
	it("passes when the published package's runtime deps are all public/catalog", async () => {
		const outcome = await run(
			repo({
				packages: {
					"fabrika-cli": {
						name: "@kampus/fabrika-cli",
						dependencies: {effect: "catalog:"},
						devDependencies: {vitest: "catalog:"},
					},
				},
			}),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("1 published package (@kampus/fabrika-cli)");
		expect(outcome.stderr).toEqual([]);
	});

	// Only the published set is in scope: a private member's dirty graph never ships.
	it("ignores a member that publish.yml does not publish", async () => {
		const outcome = await run(
			repo({
				packages: {
					"fabrika-cli": {name: "@kampus/fabrika-cli", dependencies: {effect: "catalog:"}},
					"internal-lib": {
						name: "@kampus/internal-lib",
						dependencies: {"@kampus/internal-only": "workspace:*"},
					},
				},
			}),
		);
		expect(outcome.code).toBe(0);
	});

	it("reds a workspace:* link on the violation seat, with nothing on stdout", async () => {
		const outcome = await run(
			repo({
				packages: {
					"fabrika-cli": {
						name: "@kampus/fabrika-cli",
						dependencies: {effect: "catalog:", "@kampus/epic-ledger": "workspace:*"},
					},
				},
			}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("@kampus/epic-ledger");
	});

	it("reds a private @kampus dep pinned to a version", async () => {
		const outcome = await run(
			repo({
				packages: {
					"fabrika-cli": {
						name: "@kampus/fabrika-cli",
						dependencies: {"@kampus/leak-guard": "^1.0.0"},
					},
				},
			}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("private/unpublished @kampus package");
	});

	it("annotates each offending package.json under Actions", async () => {
		const outcome = await run(
			repo({
				packages: {
					"fabrika-cli": {
						name: "@kampus/fabrika-cli",
						dependencies: {"@kampus/epic-ledger": "workspace:*"},
					},
				},
			}),
			{GITHUB_ACTIONS: "true"},
		);
		expect(
			outcome.stderr.some((line) =>
				line.startsWith("::error file=packages/fabrika-cli/package.json::"),
			),
		).toBe(true);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(
			repo({
				packages: {
					"fabrika-cli": {
						name: "@kampus/fabrika-cli",
						dependencies: {"@kampus/epic-ledger": "workspace:*"},
					},
				},
			}),
		);
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// The drift case: publish.yml names a release tag whose prefix maps to no member, so the
	// derived scope is a broken assumption rather than a narrower scan.
	it("fails closed when a publish.yml tag prefix maps to no workspace member", async () => {
		const outcome = await run(
			repo({
				prefixes: ["fabrika-cli"],
				packages: {
					"something-else": {name: "@kampus/something-else", dependencies: {effect: "catalog:"}},
				},
			}),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("map to no workspace member");
	});

	it("fails closed when publish.yml declares no release-tag grammar", async () => {
		const outcome = await run(
			repo({
				prefixes: [],
				packages: {
					"fabrika-cli": {name: "@kampus/fabrika-cli", dependencies: {effect: "catalog:"}},
				},
			}),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("derived ZERO published packages");
	});

	it("fails closed when publish.yml is absent", async () => {
		const options = repo({packages: {"fabrika-cli": {name: "@kampus/fabrika-cli"}}});
		const files = {...options.files, [WORKFLOW]: null};
		const outcome = await run({...options, files});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("does not exist");
	});

	it("passes a two-prefix publish.yml when both published members are clean", async () => {
		const outcome = await run(
			repo({
				prefixes: ["fabrika-cli", "pipeline-cli"],
				packages: {
					"fabrika-cli": {name: "@kampus/fabrika-cli", dependencies: {effect: "catalog:"}},
					"pipeline-cli": {name: "@kampus/pipeline-cli", dependencies: {effect: "catalog:"}},
				},
			}),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("2 published packages");
	});

	it("reds a two-prefix publish.yml when the SECOND package links a workspace:* dep", async () => {
		const outcome = await run(
			repo({
				prefixes: ["fabrika-cli", "pipeline-cli"],
				packages: {
					"fabrika-cli": {name: "@kampus/fabrika-cli", dependencies: {effect: "catalog:"}},
					"pipeline-cli": {
						name: "@kampus/pipeline-cli",
						dependencies: {"@kampus/internal-lib": "workspace:*"},
					},
				},
			}),
		);
		expect(outcome.code).toBe(VIOLATION);
	});

	it("answers UNKNOWN when a workspace manifest does not parse", async () => {
		const outcome = await run(repo({packages: {"fabrika-cli": "{not json"}}));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("do not parse as JSON");
	});

	it("answers UNKNOWN when a workspace manifest cannot be read", async () => {
		const options = repo({
			packages: {"fabrika-cli": {name: "@kampus/fabrika-cli", dependencies: {effect: "catalog:"}}},
		});
		const outcome = await run({
			...options,
			unreadable: [`${ROOT}/packages/fabrika-cli/package.json`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runPublishIsolationGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("no repo root");
	});
});
