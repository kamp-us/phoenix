import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {
	isolatedEnvironment,
	subjectServerContainerArgs,
	subjectTestContainerArgs,
} from "./ci-produce-verb.ts";
import {LOCALHOST_DECLARATIONS_PATH, parseLocalhostDeclarations} from "./localhost-evidence.ts";

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
		assert.include(dockerfile, "pnpm install --frozen-lockfile");
		assert.include(dockerfile, "USER node");
		const test = subjectTestContainerArgs("subject", ["pnpm", "test"]);
		assert.include(test, "none");
		assert.include(test, "--read-only");
		assert.notInclude(test.join(" "), "authority");
		assert.notInclude(test.join(" "), "review-ui-localhost-tuval");

		const server = subjectServerContainerArgs(
			"subject",
			"subject-server",
			"/trusted-fixture",
			4173,
			["node", "server.mjs", "4173"],
		);
		assert.include(server, "--read-only");
		assert.include(server, "type=bind,src=/trusted-fixture,dst=/review-ui-fixture,readonly");
		assert.notInclude(server.join(" "), "authority");
		assert.notInclude(server.join(" "), "review-ui-localhost-tuval");
	});

	it("keeps the governance namespace rooted over .github", () => {
		const config = read(".fabrika.jsonc");
		assert.include(config, '"governedRoots": [".decisions/", ".claude/", ".github/"');
	});
});
