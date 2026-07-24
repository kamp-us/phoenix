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
