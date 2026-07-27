import {assert, describe, it} from "@effect/vitest";
import {isMilestoneTitle, route} from "./router.ts";

const REPO = "kamp-us/phoenix";
const r = (argv: ReadonlyArray<string>, bodyFileExists?: (p: string) => boolean) =>
	route(argv, bodyFileExists ? {repo: REPO, bodyFileExists} : {repo: REPO});

describe("route — GraphQL-breaking verbs are routed or blocked", () => {
	it("blocks `gh project` (Projects-classic, no REST surface)", () => {
		const out = r(["project", "list"]);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") assert.include(out.hint, "REST");
	});

	it("rewrites `gh pr edit N --body` to a REST PATCH", () => {
		const out = r(["pr", "edit", "42", "--body", "new body"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.deepStrictEqual(
				[...out.argv],
				["api", "-X", "PATCH", `repos/${REPO}/issues/42`, "-f", "body=new body"],
			);
		}
	});

	it("rewrites `gh issue edit N --title` to a REST PATCH on the issues resource", () => {
		const out = r(["issue", "edit", "7", "--title", "Renamed"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${REPO}/issues/7`);
			assert.include(out.argv, "title=Renamed");
		}
	});

	it("strips closingIssuesReferences from a `pr view --json` projection", () => {
		const out = r(["pr", "view", "9", "--json", "number,closingIssuesReferences,title"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.stripped, "closingIssuesReferences");
			assert.include(out.argv, "number,title");
			assert.notInclude(out.argv.join(" "), "closingIssuesReferences");
		}
	});

	it("blocks a `view --json` that requests ONLY GraphQL-breaking fields", () => {
		const out = r(["issue", "view", "9", "--json", "projectCards,closingIssuesReferences"]);
		assert.strictEqual(out.kind, "block");
	});

	it("flags a milestone TITLE for resolution instead of passing the raw title", () => {
		const out = r(["issue", "edit", "5", "--milestone", "Make the gates real"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.isTrue(out.stripped.some((s) => s.startsWith("milestone-title:")));
			// the raw title is NOT shoved into the REST argv as a number
			assert.notInclude(out.argv.join(" "), "Make the gates real");
		}
	});

	it("passes a numeric milestone straight through to the REST PATCH", () => {
		const out = r(["pr", "edit", "5", "--milestone", "3"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.strictEqual(out.stripped.length, 0);
			assert.include(out.argv, "milestone=3");
		}
	});

	it("blocks `--body-file` when the path does not exist", () => {
		const out = r(["pr", "edit", "42", "--body-file", "/nope/missing.md"], () => false);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") assert.include(out.reason, "--body-file");
	});

	it("rewrites `--body-file` to a REST `-F body=@path` when the file exists", () => {
		const out = r(["pr", "edit", "42", "--body-file", "/tmp/body.md"], () => true);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") assert.include(out.argv, "body=@/tmp/body.md");
	});
});

describe("route — safe REST verbs pass through unchanged", () => {
	it("passes a plain `gh api repos/...` REST call through verbatim", () => {
		const argv = ["api", `repos/${REPO}/issues/1`, "--jq", ".title"];
		const out = r(argv);
		assert.strictEqual(out.kind, "passthrough");
		if (out.kind === "passthrough") assert.deepStrictEqual([...out.argv], argv);
	});

	it("passes `gh pr create` through (no GraphQL edit path)", () => {
		const out = r(["pr", "create", "--base", "main", "--title", "x", "--body", "y"]);
		assert.strictEqual(out.kind, "passthrough");
	});

	it("passes a `view --json` with no breaking fields through", () => {
		const out = r(["pr", "view", "9", "--json", "number,title,state"]);
		assert.strictEqual(out.kind, "passthrough");
	});

	it("passes `gh pr list` through", () => {
		const out = r(["pr", "list", "--state", "open"]);
		assert.strictEqual(out.kind, "passthrough");
	});
});

describe("route — an unresolved repo refuses the rewrite, not the whole shim (#4270)", () => {
	const unresolved = (argv: ReadonlyArray<string>) => route(argv, {repo: null});

	it("blocks `gh pr edit` and names $CLAUDE_PIPELINE_REPO instead of PATCHing a default repo", () => {
		const out = unresolved(["pr", "edit", "42", "--body", "new body"]);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") {
			assert.include(out.hint, "CLAUDE_PIPELINE_REPO");
			// the refusal must not smuggle a repo slug into the argv it declined to build
			assert.notInclude(`${out.reason} ${out.hint}`, "repos/");
		}
	});

	it("blocks `gh issue edit` on an unresolved repo too", () => {
		const out = unresolved(["issue", "edit", "7", "--title", "Renamed"]);
		assert.strictEqual(out.kind, "block");
	});

	it("leaves a passthrough that needs no repo unaffected", () => {
		const argv = ["api", "repos/other-owner/other-repo/issues/1", "--jq", ".title"];
		const out = unresolved(argv);
		assert.strictEqual(out.kind, "passthrough");
		if (out.kind === "passthrough") assert.deepStrictEqual([...out.argv], argv);
	});

	it("still strips GraphQL-only view fields, which need no repo", () => {
		const out = unresolved(["pr", "view", "9", "--json", "number,closingIssuesReferences"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") assert.include(out.stripped, "closingIssuesReferences");
	});
});

describe("route — an explicit -R/--repo names the PATCH target (#4301)", () => {
	const OTHER = "other-owner/other-repo";

	it("PATCHes the -R repo, not the resolved one, for `pr edit`", () => {
		const out = r(["pr", "edit", "-R", OTHER, "5", "--title", "x"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${OTHER}/issues/5`);
			assert.notInclude(out.argv.join(" "), REPO);
			assert.include(out.reason, OTHER);
		}
	});

	it("PATCHes the --repo=value repo, not the resolved one, for `pr edit`", () => {
		const out = r(["pr", "edit", "5", `--repo=${OTHER}`, "--body", "b"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${OTHER}/issues/5`);
			assert.notInclude(out.argv.join(" "), REPO);
		}
	});

	it("PATCHes the --repo repo, not the resolved one, for `issue edit`", () => {
		const out = r(["issue", "edit", "--repo", OTHER, "7", "--title", "Renamed"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${OTHER}/issues/7`);
			assert.notInclude(out.argv.join(" "), REPO);
		}
	});

	it("PATCHes the -R=value repo, not the resolved one, for `issue edit`", () => {
		const out = r(["issue", "edit", "7", `-R=${OTHER}`, "--body", "b"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${OTHER}/issues/7`);
			assert.notInclude(out.argv.join(" "), REPO);
		}
	});

	it("honors the attached shorthand `-Rowner/name`", () => {
		const out = r(["pr", "edit", "5", `-R${OTHER}`, "--title", "x"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") assert.include(out.argv, `repos/${OTHER}/issues/5`);
	});

	it("supplies a target even when the shim resolved no repo", () => {
		const out = route(["pr", "edit", "-R", OTHER, "5", "--title", "x"], {repo: null});
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") assert.include(out.argv, `repos/${OTHER}/issues/5`);
	});

	it("blocks a -R value that is not an owner/name slug, naming the flag and value", () => {
		const out = r(["pr", "edit", "5", "-R", "not-a-slug", "--title", "x"]);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") {
			assert.include(out.reason, "-R");
			assert.include(out.reason, "not-a-slug");
			assert.notInclude(`${out.reason} ${out.hint}`, REPO);
		}
	});

	it("blocks a trailing --repo with no value rather than falling back to the resolved repo", () => {
		const out = r(["pr", "edit", "5", "--title", "x", "--repo"]);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") assert.include(out.reason, "--repo");
	});

	it("leaves every other edit flag's handling unchanged alongside -R", () => {
		const out = r([
			"issue",
			"edit",
			"-R",
			OTHER,
			"7",
			"--title",
			"x",
			"--milestone",
			"3",
			"--add-project",
			"Roadmap",
		]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, "title=x");
			assert.include(out.argv, "milestone=3");
			assert.include(out.stripped, "--add-project Roadmap");
		}
	});
});

describe("route — -R still reaches real `gh` untouched on the non-edit routes (#4301 regression)", () => {
	const OTHER = "other-owner/other-repo";

	it("passes -R through verbatim on a passthrough route", () => {
		const argv = ["pr", "list", "-R", OTHER, "--state", "open"];
		const out = r(argv);
		assert.strictEqual(out.kind, "passthrough");
		if (out.kind === "passthrough") assert.deepStrictEqual([...out.argv], argv);
	});

	it("keeps -R in the rebuilt argv of a `view --json` rewrite", () => {
		const out = r(["pr", "view", "9", "-R", OTHER, "--json", "number,closingIssuesReferences"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, "-R");
			assert.include(out.argv, OTHER);
		}
	});
});

describe("route — the edit target is positional, not the first bare integer (#4339)", () => {
	it("targets the positional 5, not the `--milestone 3` value that precedes it", () => {
		const out = r(["pr", "edit", "--milestone", "3", "5", "--title", "x"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${REPO}/issues/5`);
			assert.notInclude(out.argv, `repos/${REPO}/issues/3`);
			assert.include(out.argv, "milestone=3");
			assert.include(out.argv, "title=x");
		}
	});

	it("does not consume the token after a `--milestone=3` attached value", () => {
		const out = r(["issue", "edit", "--milestone=3", "5", "--body", "b"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") {
			assert.include(out.argv, `repos/${REPO}/issues/5`);
			assert.include(out.argv, "milestone=3");
			assert.include(out.argv, "body=b");
		}
	});

	it("skips a value-taking flag the rewrite itself does not model", () => {
		const out = r(["issue", "edit", "--add-label", "bug", "7", "--body", "y"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") assert.include(out.argv, `repos/${REPO}/issues/7`);
	});

	it("blocks when every integer in the argv is a flag value and no positional follows", () => {
		const out = r(["pr", "edit", "--milestone", "3", "--title", "x"]);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") assert.include(out.hint, "-X PATCH");
	});

	it("blocks a `--body 5` whose only integer is the body text", () => {
		const out = r(["pr", "edit", "--body", "5"]);
		assert.strictEqual(out.kind, "block");
	});

	it("blocks a non-numeric positional (a PR branch selector) with the REST hint", () => {
		const out = r(["pr", "edit", "my-branch", "--title", "x"]);
		assert.strictEqual(out.kind, "block");
		if (out.kind === "block") {
			assert.include(out.reason, "numeric");
			assert.include(out.hint, `repos/${REPO}/pulls/<N>`);
		}
	});

	it("keeps the target-first orderings working", () => {
		const pr = r(["pr", "edit", "5", "--title", "x"]);
		assert.strictEqual(pr.kind, "rewrite");
		if (pr.kind === "rewrite") assert.include(pr.argv, `repos/${REPO}/issues/5`);
		const issue = r(["issue", "edit", "7", "--body", "y"]);
		assert.strictEqual(issue.kind, "rewrite");
		if (issue.kind === "rewrite") assert.include(issue.argv, `repos/${REPO}/issues/7`);
	});

	it("reads the target after an `--` end-of-flags separator", () => {
		const out = r(["pr", "edit", "--title", "x", "--", "5"]);
		assert.strictEqual(out.kind, "rewrite");
		if (out.kind === "rewrite") assert.include(out.argv, `repos/${REPO}/issues/5`);
	});
});

describe("isMilestoneTitle", () => {
	it("treats a bare integer as a number (not a title)", () => {
		assert.isFalse(isMilestoneTitle("12"));
		assert.isFalse(isMilestoneTitle("  3 "));
	});
	it("treats any non-numeric value as a title", () => {
		assert.isTrue(isMilestoneTitle("Make the gates real"));
		assert.isTrue(isMilestoneTitle("v1.0"));
	});
});
