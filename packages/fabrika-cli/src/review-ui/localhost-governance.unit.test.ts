import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {
	boundedBrowserErrors,
	isolatedEnvironment,
	subjectInstallAndTestContainerArgs,
	subjectPrepareServerContainerArgs,
	subjectServerContainerArgs,
} from "./ci-produce-verb.ts";
import {
	BROWSER_ERROR_TEXT_CAP,
	LOCALHOST_DECLARATIONS_PATH,
	parseLocalhostDeclarations,
} from "./localhost-evidence.ts";

const root = resolve(import.meta.dirname, "../../../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("localhost evidence governance floor", () => {
	it("keeps the authority and every declared producer under the CODEOWNERS-governed .github root", () => {
		const authority = parseLocalhostDeclarations(read(LOCALHOST_DECLARATIONS_PATH));
		assert.strictEqual(authority._tag, "Declarations");
		if (authority._tag !== "Declarations") return;
		const owners = read(".github/CODEOWNERS");
		assert.match(owners, /^\/\.github\/\s+@kamp-us\/control-plane$/m);
		assert.match(owners, /^\/packages\/fabrika-cli\/src\/review-ui\/\s+@kamp-us\/control-plane$/m);
		for (const harness of authority.value.harnesses) {
			assert.match(harness.workflow, /^\.github\/workflows\/[a-z0-9-]+\.yml$/);
			const workflow = read(harness.workflow);
			assert.include(workflow, "pull_request_target:");
			assert.include(workflow, `name: ${harness.check}`);
			assert.include(workflow, `name: ${harness.artifact}`);
			assert.include(workflow, `--harness ${harness.id}`);
			assert.include(workflow, "persist-credentials: false");
			assert.notInclude(workflow, "working-directory: subject");
			assert.notInclude(workflow, "GITHUB_TOKEN:");
		}
	});

	it("does not pass Actions credentials or workflow command files into PR code", () => {
		assert.deepStrictEqual(
			isolatedEnvironment({
				PATH: "/bin",
				CI: "true",
				GITHUB_TOKEN: "secret",
				GITHUB_ENV: "/tmp/env",
				ACTIONS_RUNTIME_TOKEN: "runtime",
				NPM_TOKEN: "npm",
			}),
			{PATH: "/bin", CI: "true"},
		);
	});

	it("gives PR execution no authority or artifact-output filesystem mount", () => {
		assert.include(
			read("packages/fabrika-cli/src/review-ui/ci-produce-verb.ts"),
			".github/review-ui-localhost-subject.Dockerfile",
		);
		const dockerfile = read(".github/review-ui-localhost-subject.Dockerfile");
		assert.include(dockerfile, "pnpm fetch --frozen-lockfile --ignore-scripts --ignore-pnpmfile");
		assert.notInclude(dockerfile, "pnpm install --frozen-lockfile");
		assert.include(dockerfile, "USER node");
		const test = subjectInstallAndTestContainerArgs("subject", "subject-workspace", [
			"pnpm",
			"test",
		]);
		assert.include(test, "none");
		assert.include(test, "--read-only");
		assert.include(test, "--cap-drop");
		assert.include(test, "no-new-privileges");
		assert.include(
			test,
			'cp -a /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile && exec "$@"',
		);
		assert.notInclude(test.join(" "), "authority");
		assert.notInclude(test.join(" "), "review-ui-localhost-tuval");

		const serverPreparation = subjectPrepareServerContainerArgs(
			"subject",
			"fresh-server-workspace",
		);
		assert.include(serverPreparation, "none");
		assert.include(serverPreparation, "--read-only");
		assert.include(serverPreparation, "no-new-privileges");
		assert.include(
			serverPreparation,
			"cp -a /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
		);
		assert.notInclude(serverPreparation.join(" "), "subject-test-workspace");

		const server = subjectServerContainerArgs(
			"subject",
			"subject-server",
			"fresh-server-workspace",
			"/trusted-fixture",
			4173,
			["node", "server.mjs", "4173"],
		);
		assert.include(server, "--read-only");
		assert.include(server, "--cap-drop");
		assert.include(server, "no-new-privileges");
		assert.include(server, "type=volume,src=fresh-server-workspace,dst=/subject,readonly");
		assert.include(server, "type=bind,src=/trusted-fixture,dst=/review-ui-fixture,readonly");
		assert.notInclude(server.join(" "), "authority");
		assert.notInclude(server.join(" "), "review-ui-localhost-tuval");
	});

	it("bounds every browser-error row while preserving deterministic priority and overflow", () => {
		const oversized = "x".repeat(BROWSER_ERROR_TEXT_CAP + 500);
		const bounded = boundedBrowserErrors([
			{kind: "console.error", text: oversized},
			{kind: "pageerror", text: oversized},
			{kind: "console.error", text: "second console"},
			{kind: "pageerror", text: "second page"},
		]);
		assert.deepStrictEqual(
			bounded.rows.map((row) => row.kind),
			["pageerror", "pageerror", "console.error"],
		);
		assert.strictEqual(bounded.rows[0]?.text.length, BROWSER_ERROR_TEXT_CAP);
		assert.strictEqual(bounded.rows[2]?.text.length, BROWSER_ERROR_TEXT_CAP);
		assert.strictEqual(bounded.more, 1);
	});

	it("keeps every review-ui verb contract locally complete", () => {
		const contract = read("claude-plugins/fabrika/skills/review-ui/contract.md");
		const verbs = ["fetch", "ci-produce", "render", "post", "note", "route"];
		const headings = [
			"Invocation",
			"Inputs",
			"Output",
			"Exit status",
			"Errors",
			"Scope",
			"Examples",
			"Grounding",
		];
		for (const [index, verb] of verbs.entries()) {
			const start = contract.indexOf(`## \`review-ui ${verb}\``);
			const next =
				index === verbs.length - 1
					? contract.length
					: contract.indexOf("\n## `review-ui ", start + 1);
			assert.isAtLeast(start, 0, `review-ui ${verb} section`);
			const section = contract.slice(start, next < 0 ? contract.length : next);
			for (const heading of headings) {
				assert.include(section, `**${heading}**`, `review-ui ${verb} ${heading}`);
			}
			assert.include(section, `$ fabrika review-ui ${verb}`, `review-ui ${verb} literal example`);
		}
	});

	it("keeps the governance namespace rooted over .github", () => {
		const config = read(".fabrika.jsonc");
		assert.include(config, '"governedRoots": [".decisions/", ".claude/", ".github/"');
	});
});
