import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {
	boundedBrowserErrors,
	captureOutputContainerArgs,
	captureVolumeKeeperContainerArgs,
	isolatedEnvironment,
	subjectCaptureContainerArgs,
	subjectInstallAndTestContainerArgs,
	subjectPrepareServerContainerArgs,
	subjectServerContainerArgs,
	subjectVolumeCreateArgs,
	subjectVolumeKeeperContainerArgs,
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
		for (const authorityPath of [
			"review-ui/",
			"ship/github.ts",
			"capture/capture.ts",
			"capture/png.ts",
			"ui/png.ts",
			"capture/upload.ts",
		]) {
			assert.match(
				owners,
				new RegExp(
					`^/packages/fabrika-cli/src/${authorityPath.replaceAll(".", "\\.")}\\s+@kamp-us/control-plane$`,
					"m",
				),
			);
		}
		for (const decision of [
			".decisions/0299-cp-fence-covers-fabrika-ci-core.md",
			".decisions/0330-codeowners-is-the-cp-boundary.md",
		]) {
			assert.include(read(decision), "`src/ui/png.ts`");
		}
		for (const harness of authority.value.harnesses) {
			assert.match(harness.workflow, /^\.github\/workflows\/[a-z0-9-]+\.yml$/);
			const workflow = read(harness.workflow);
			assert.include(workflow, "pull_request_target:");
			assert.include(
				workflow,
				`run-name: "review-ui localhost evidence / ${harness.id} / PR #\${{ github.event.pull_request.number }} / subject \${{ github.event.pull_request.head.sha }} / authority \${{ github.sha }}"`,
			);
			assert.include(workflow, `name: ${harness.check}`);
			assert.include(workflow, `name: ${harness.artifact}`);
			assert.include(workflow, `--harness ${harness.id}`);
			assert.include(workflow, '--authority-head "$AUTHORITY_HEAD"');
			assert.include(workflow, "pnpm install --frozen-lockfile\n          status=$?");
			assert.include(
				workflow,
				"pnpm exec playwright install --with-deps chromium\n          status=$?",
			);
			assert.include(workflow, "persist-credentials: false");
			assert.notInclude(workflow, "working-directory: subject");
			assert.notInclude(workflow, "GITHUB_TOKEN:");
		}
	});

	it("boots pnpm from the governed manifest in the nested authority checkout", () => {
		const authority = parseLocalhostDeclarations(read(LOCALHOST_DECLARATIONS_PATH));
		assert.strictEqual(authority._tag, "Declarations");
		if (authority._tag !== "Declarations") return;
		const packageManifest = JSON.parse(read("package.json")) as {packageManager?: unknown};
		assert.match(String(packageManifest.packageManager), /^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/);
		for (const harness of authority.value.harnesses) {
			const workflow = read(harness.workflow);
			assert.include(workflow, "path: authority");
			assert.match(
				workflow,
				/- uses: pnpm\/action-setup@v4\.1\.0\n\s+with:\n\s+package_json_file: authority\/package\.json/,
			);
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
		assert.include(dockerfile, "chown node:node /subject /subject-source /capture-output");
		assert.include(dockerfile, "USER node");
		const test = subjectInstallAndTestContainerArgs("subject", "subject-workspace", [
			"pnpm",
			"test",
		]);
		assert.include(test, "none");
		assert.include(test, "--read-only");
		assert.include(test, "--cap-drop");
		assert.include(test, "no-new-privileges");
		assert.include(test, "--name");
		assert.include(test, "subject-test");
		assert.include(test, "--cpus");
		assert.include(test, "--memory");
		assert.include(test, "--pids-limit");
		assert.include(
			test,
			'cp -R /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile && exec "$@"',
		);
		assert.notInclude(test.join(" "), "authority");
		assert.notInclude(test.join(" "), "review-ui-localhost-tuval");

		const serverPreparation = subjectPrepareServerContainerArgs(
			"subject",
			"fresh-server-workspace",
			["pnpm", "--filter", "tuval", "build"],
		);
		assert.include(serverPreparation, "none");
		assert.include(serverPreparation, "--read-only");
		assert.include(serverPreparation, "no-new-privileges");
		assert.include(serverPreparation, "--name");
		assert.include(serverPreparation, "subject-server-prepare");
		assert.include(serverPreparation, "--cpus");
		assert.include(serverPreparation, "--memory");
		assert.include(serverPreparation, "--pids-limit");
		assert.include(
			serverPreparation,
			'cp -R /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile && exec "$@"',
		);
		assert.include(serverPreparation.join(" "), "pnpm --filter tuval build");
		assert.notInclude(serverPreparation.join(" "), "subject-test-workspace");

		const server = subjectServerContainerArgs(
			"subject",
			"subject-server",
			"fresh-server-workspace",
			"/trusted-fixture",
			["node", "server.mjs", "4173"],
		);
		assert.include(server.join(" "), "--network none");
		assert.notInclude(server, "--publish");
		assert.notInclude(server, "--rm");
		assert.include(server, "--read-only");
		assert.include(server, "--cap-drop");
		assert.include(server, "no-new-privileges");
		assert.include(server, "--cpus");
		assert.include(server, "--memory");
		assert.include(server, "--pids-limit");
		assert.include(server, "type=volume,src=fresh-server-workspace,dst=/subject,readonly");
		assert.include(server, "type=bind,src=/trusted-fixture,dst=/review-ui-fixture,readonly");
		assert.notInclude(server.join(" "), "authority");
		assert.notInclude(server.join(" "), "review-ui-localhost-tuval");

		const serverKeeper = subjectVolumeKeeperContainerArgs(
			"subject",
			"fresh-server-workspace",
			"subject-server-keeper",
		);
		assert.include(serverKeeper.join(" "), "--detach --network none");
		assert.include(serverKeeper, "--read-only");
		assert.include(serverKeeper, "--cap-drop");
		assert.include(serverKeeper, "no-new-privileges");
		assert.include(serverKeeper, "--cpus");
		assert.include(serverKeeper, "0.1");
		assert.include(serverKeeper, "--memory");
		assert.include(serverKeeper, "64m");
		assert.include(serverKeeper, "--pids-limit");
		assert.include(serverKeeper, "16");
		assert.include(serverKeeper, "type=volume,src=fresh-server-workspace,dst=/subject");
		assert.notInclude(serverKeeper.join(" "), "authority");
		assert.notInclude(serverKeeper.join(" "), "GITHUB_TOKEN");

		const capture = subjectCaptureContainerArgs(
			"subject",
			"subject-server",
			"/authority",
			"capture-output",
			4173,
			"tuval",
		);
		assert.include(capture.join(" "), "--network container:subject-server");
		assert.include(capture, "type=bind,src=/authority,dst=/authority,readonly");
		assert.include(capture, "type=volume,src=capture-output,dst=/capture-output");
		assert.include(capture, "--read-only");
		assert.include(capture, "no-new-privileges");
		assert.include(capture, "--name");
		assert.include(capture, "subject-server-capture");
		assert.include(capture, "--cpus");
		assert.include(capture, "--memory");
		assert.include(capture, "--pids-limit");

		const keeper = captureVolumeKeeperContainerArgs(
			"subject",
			"capture-output",
			"subject-capture-keeper",
		);
		assert.include(keeper.join(" "), "--detach --network none");
		assert.include(keeper, "--read-only");
		assert.include(keeper, "--cap-drop");
		assert.include(keeper, "no-new-privileges");
		assert.include(keeper, "--cpus");
		assert.include(keeper, "0.1");
		assert.include(keeper, "--memory");
		assert.include(keeper, "64m");
		assert.include(keeper, "--pids-limit");
		assert.include(keeper, "16");
		assert.include(keeper, "type=volume,src=capture-output,dst=/capture-output");
		assert.notInclude(keeper.join(" "), "authority");
		assert.notInclude(keeper.join(" "), "GITHUB_TOKEN");

		const extraction = captureOutputContainerArgs(
			"subject",
			"capture-output",
			"/trusted-output",
			"subject-capture-extract",
		);
		assert.include(extraction, "type=volume,src=capture-output,dst=/capture,readonly");
		assert.include(extraction, "type=bind,src=/trusted-output,dst=/output");
		assert.include(extraction, "--cpus");
		assert.include(extraction, "--memory");
		assert.include(extraction, "--pids-limit");

		const volume = subjectVolumeCreateArgs("subject-workspace");
		assert.deepStrictEqual(volume.slice(-2), ["o=size=4g", "subject-workspace"]);
		assert.include(volume, "type=tmpfs");
	});

	it("documents the complete Tuval desktop and mobile fetch success", () => {
		const command = read("packages/fabrika-cli/src/review-ui/command.ts");
		assert.include(command, '"surfaces":2');
		assert.include(command, '"surface":"tuval-cockpit-desktop"');
		assert.include(command, '"surface":"tuval-cockpit-mobile"');
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

	it("requires all localhost wire reads before fetch and routes PR-state recovery to ship", () => {
		const skill = read("claude-plugins/fabrika/skills/review-ui/SKILL.md");
		const fetchInvocation = skill.indexOf(
			"fabrika review-ui fetch $pr_number --harness tuval --out judged",
		);
		for (const heading of ["review-ui fetch", "review-ui post", "The shared exit matrix"]) {
			const contractRead = skill.indexOf(`--heading "${heading}"`);
			assert.isAtLeast(contractRead, 0);
			assert.isBelow(contractRead, fetchInvocation);
		}
		const runbook = read("ops/runbook-review-ui-localhost-evidence.md");
		assert.include(
			runbook,
			"fabrika ship nudge 7190 --sha d293fe694bfd740475753bad3b00c630a9835122",
		);
		for (const fence of runbook.matchAll(/```bash\n([\s\S]*?)```/g)) {
			assert.notMatch(fence[1] ?? "", /\$(?:\(|[A-Za-z_{])/);
		}
		assert.notInclude(runbook, "Close #7190 without merging it");
		const contract = read("claude-plugins/fabrika/skills/review-ui/contract.md");
		assert.include(contract, "`render` equal to `clean` or `red`");
		assert.notInclude(contract, "has no readable preview manifest");
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

	it("pins fetch and ci-produce contract inputs to their shipped flag help", () => {
		const contract = read("claude-plugins/fabrika/skills/review-ui/contract.md");
		const command = read("packages/fabrika-cli/src/review-ui/command.ts");
		const descriptions = [
			"the pull-request number this verb acts on",
			"a localhost-only harness declared by the repository's governed authority",
			"kebab-case reviewer-owned capture-set name",
			"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			"the exact lowercase 40-character PR head checked out as the subject",
			"the exact default-branch authority revision checked out as trusted code",
			"the localhost harness id from the trusted declaration",
			"the positive GitHub Actions run id bound into the manifest",
			"the owner/name repository identity bound into the manifest",
			"the exact-head subject input to the trusted image recipe",
			"the trusted base checkout containing the declaration and producer",
			"the trusted host directory where captures and manifest are written",
		];
		for (const description of descriptions) {
			assert.include(command, `"${description}"`);
			assert.include(contract, `| ${description} |`);
		}
	});

	it("keeps the governance namespace rooted over .github", () => {
		const config = read(".fabrika.jsonc");
		assert.include(config, '"governedRoots": [".decisions/", ".claude/", ".github/"');
	});
});
