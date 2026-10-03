import {describe, expect, it} from "vitest";
import type {ChildOutcome} from "../io/exec.ts";
import {decideStash, findGitStash, PATTERN_DOC, readGitDirs} from "./git-stash.ts";

describe("findGitStash", () => {
	it.each([
		"git stash",
		"git stash pop",
		"git stash push -u -m wip",
		"git stash list",
		'git -C "/some/tree" stash push',
		"git -C /wt -c core.pager=cat stash apply",
		"git --no-pager stash show -p",
		"/usr/bin/git stash",
		"pnpm test && git stash",
		"git status; git stash pop",
		"git fetch origin | tee log || git stash",
		"(git stash)",
		"{ git stash; }",
		"echo $(git stash)",
		'echo "$(git stash)"',
		"echo `git stash`",
		"GIT_TRACE=1 git stash",
		"env -u HOME FOO=1 git stash",
		"command git stash",
		"if git stash; then echo ok; fi",
		"bash -c 'git stash pop'",
		'sh -lc "cd /x && git stash"',
		"eval git stash",
		"git stash 2>&1",
		"git stash >/dev/null",
		"git 'stash'",
		"cat <<EOF\nnot a command\nEOF\ngit stash",
	])("finds the stash in %j", (command) => {
		expect(findGitStash(command)._tag).toBe("Stash");
	});

	it.each([
		"git status",
		"git commit -m 'git stash is banned'",
		'echo "git stash"',
		"grep -rn 'git stash' .",
		"git log --grep stash",
		"git -C stash status",
		"git show stash",
		"echo git stash",
		"# git stash\nls",
		"fabrika build commit <<'EOF'\nfix: never run\ngit stash pop\nEOF",
		"cat <<-EOF\n\tgit stash\n\tEOF",
		"cat <<< 'git stash'",
		"git reflog stash",
	])("finds none in %j", (command) => {
		expect(findGitStash(command)).toEqual({_tag: "None"});
	});

	it("names the simple command that runs it", () => {
		expect(findGitStash("pnpm test && git -C /wt stash pop")).toEqual({
			_tag: "Stash",
			invocation: "git -C /wt stash pop",
		});
	});
});

const ran = (stdout: string, exitCode: number | null = 0, stderr = ""): ChildOutcome => ({
	_tag: "Ran",
	exitCode,
	timedOut: exitCode === null,
	stdout: new TextEncoder().encode(stdout),
	stderr: new TextEncoder().encode(stderr),
	truncated: false,
});

describe("readGitDirs", () => {
	it("reads two absolute paths", () => {
		expect(readGitDirs(ran("/r/.git/worktrees/a\n/r/.git\n"), 5)).toEqual({
			_tag: "Read",
			dirs: {gitDir: "/r/.git/worktrees/a", commonDir: "/r/.git"},
		});
	});

	it.each<[string, ChildOutcome, string]>([
		["a timeout", ran("", null), "did not finish within 5s"],
		["an unstartable git", {_tag: "Unstartable", reason: "spawn git ENOENT"}, "could not run git"],
		["a failed rev-parse", ran("", 128, "fatal: not a git repository"), "not a git repository"],
		["one line", ran("/r/.git\n"), "1 line(s)"],
		["a relative path", ran(".git\n.git\n"), "relative path"],
	])("is Unread on %s", (_label, outcome, reason) => {
		const read = readGitDirs(outcome, 5);
		expect(read._tag).toBe("Unread");
		expect(read._tag === "Unread" ? read.reason : "").toContain(reason);
	});
});

describe("decideStash", () => {
	it("denies a stash in a linked worktree, naming the shared stack and the pattern doc", () => {
		const decision = decideStash("git stash pop", {
			gitDir: "/r/.git/worktrees/a",
			commonDir: "/r/.git",
		});
		expect(decision._tag).toBe("Deny");
		const reason = decision._tag === "Deny" ? decision.reason : "";
		expect(reason).toContain("refs/stash");
		expect(reason).toContain("/r/.git");
		expect(reason).toContain(PATTERN_DOC);
	});
});
