import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	BASE,
	binding,
	comments,
	files,
	HEAD,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
} from "./fixtures.test-support.ts";
import {runPost} from "./post-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
/**
 * The unbound endpoint this verb no longer reads, scripted with a **skill-only** list — so a read
 * that drifts back to it derives `review-skill` where the bound commit derives code and doc, and
 * every case below fails on a wrong answer rather than on a missing script.
 */
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const USER = /^gh api user --jq \.login$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues\/4321\/comments /;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/comments\/\d+ /;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;

const BODY = "| criterion | verdict |\n|---|---|\n| the first thing | PASS |\n";
const URL = "https://example.test/pull/4321#issuecomment-5154902211";
const MARKER = `review-doc: PASS @ ${HEAD} — guide matches shipped behavior`;

const created = okOut(JSON.stringify({id: 5154902211, html_url: URL}));

/** The instant every run below writes its verdict at, so the stamp the verb emits is predictable. */
const NOW = Date.parse("2026-08-09T06:30:00.412Z");
const STAMP = "Verdict-written: 2026-08-09T06:30:00Z";

/**
 * A read-back of `body` as the verb will have posted it — stamped, since the stamp is part of the
 * bytes the verb sends and therefore part of what its whole-comment comparison expects back.
 */
const commentBody = (body: string): ExecResult =>
	okOut(JSON.stringify({body: `${body.replace(/\s+$/, "")}\n\n${STAMP}`}));

const options = {
	pr: 4321,
	namespace: "review-doc",
	polarity: "PASS",
	sha: HEAD,
	clause: "guide matches shipped behavior",
	carrier: "marker",
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
	now: Effect.succeed(NOW),
};

const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull()],
	...binding(),
	[PATHS_AT(), paths("src/cart.ts", "README.md")],
	[FILES, files("skills/deploy/SKILL.md")],
	[USER, okOut("kampus-bot")],
	[COMMENTS, comments()],
	[CREATE, created],
	[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runPost({...options, ...overrides}), fakeShell(script).layer));

describe("runPost", () => {
	it("posts the verdict and says whether it created or edited", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`posted\treview-doc\tPASS\t${HEAD}\tcreated\t${URL}\n`);
	});

	it("puts the marker on the comment's LITERAL first line, never stacked on line 2", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		const write = shell.calls.find((call) => CREATE.test(call)) ?? "";
		const body = write.slice(write.indexOf("body=") + "body=".length);
		expect(body.split("\n")[0]).toBe(MARKER);
		expect(body.split("\n").filter((line) => line.startsWith("review-doc:"))).toHaveLength(1);
	});

	it("edits this namespace's existing comment instead of stacking a second one", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[
				COMMENTS,
				comments({
					id: 42,
					body: `review-doc: PASS @ ${OLD_HEAD} — older round`,
					author: "kampus-bot",
				}),
			],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tedited\t");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("stamps the write-recency line on the comment it creates", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		const write = shell.calls.find((call) => CREATE.test(call)) ?? "";
		expect(write).toContain(STAMP);
	});

	it("stamps the write-recency line on the comment it edits, too", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments({id: 42, body: `review-doc: FAIL @ ${OLD_HEAD} — older round`})],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		const write = shell.calls.find((call) => PATCH.test(call)) ?? "";
		expect(write).toContain(STAMP);
	});

	// The pre-#5048 upsert took the FIRST match, and the list arrives oldest-first — so on a namespace
	// that already holds two of this author's comments it edited the one the resolver is least likely
	// to be reading, and reported success.
	it("edits the NEWEST comment in the namespace when two of this author's already exist", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 2})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[
				COMMENTS,
				comments(
					{
						id: 42,
						createdAt: "2026-08-09T03:46:59Z",
						body: `review-doc: FAIL @ ${OLD_HEAD} — the older duplicate`,
					},
					{
						id: 77,
						createdAt: "2026-08-09T04:05:28Z",
						body: `review-doc: FAIL @ ${OLD_HEAD} — the newer duplicate`,
					},
				),
			],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tedited\t");
		expect(shell.calls.find((call) => PATCH.test(call))).toContain("/issues/comments/77 ");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	// The case slot-creation time gets backwards, and the reason the stamp is the key: comment 42's
	// slot is the older one, but its verdict was REWRITTEN into that slot after 77 was created. A PATCH
	// leaves `created_at` where it was, so only the stamp can say 42 now carries the later verdict.
	it("ranks by the write-recency stamp, not by when the comment slot was opened", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 2})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[
				COMMENTS,
				comments(
					{
						id: 42,
						createdAt: "2026-08-09T03:46:59Z",
						body: `review-doc: FAIL @ ${OLD_HEAD} — re-posted in place\n\nVerdict-written: 2026-08-09T05:10:00Z`,
					},
					{
						id: 77,
						createdAt: "2026-08-09T04:05:28Z",
						body: `review-doc: FAIL @ ${OLD_HEAD} — the newer slot, older verdict`,
					},
				),
			],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls.find((call) => PATCH.test(call))).toContain("/issues/comments/42 ");
	});

	it("does not edit another author's comment in the same namespace", async () => {
		const shell = fakeShell([
			[PULL, pull({comments: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments({id: 42, body: MARKER, author: "someone-else"})],
			[CREATE, created],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.stdout).toContain("\tcreated\t");
	});

	it("refuses a namespace this PR's own diff did not derive, on 10", async () => {
		const out = await run(happy(), {namespace: "review-skill"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review post: --namespace review-skill is not derived by #4321's diff (present: review-code, review-doc) — a gate never emits a namespace it did not judge.",
		);
	});

	it("refuses a third polarity token, and advisory+FAIL, on 10", async () => {
		const bad = await run(happy(), {polarity: "MAYBE"});
		expect(bad.code).toBe(OFF_VOCABULARY);
		expect(bad.stderr.at(-1)).toContain("A third token is not a polarity");

		const advisoryFail = await run(happy(), {polarity: "FAIL", carrier: "advisory"});
		expect(advisoryFail.code).toBe(OFF_VOCABULARY);
		expect(advisoryFail.stderr.at(-1)).toBe(
			"review post: --carrier advisory is a PASS path only (ADR 0226) — post the FAIL marker instead.",
		);
	});

	it("refuses a moved-past head on 12 and writes nothing — re-review, never re-bind", async () => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runPost({...options, sha: OLD_HEAD}), shell.layer),
		);
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review post: the live head is ${HEAD}, not ${OLD_HEAD} — the tree you judged is gone; re-review at ${HEAD} (ADR 0058).`,
		);
		expect(shell.calls.some((call) => CREATE.test(call) || PATCH.test(call))).toBe(false);
	});

	it("refuses an empty verdict body on 3 — an empty verdict reads as UNGATED", async () => {
		const out = await run(happy(), {stdin: Effect.succeed({_tag: "Text", text: "  \n"})});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toBe(
			"review post: no body on stdin — an empty verdict reads as UNGATED; pipe the verdict body in.",
		);
	});

	it("keeps an UNREAD pipe on 1, never on the read-but-empty code", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"}),
		});
		expect(out.code).toBe(1);
		expect(out.code).not.toBe(EMPTY_STDIN);
	});

	it("refuses a bare @ body on 6 and a machine-local path on 5", async () => {
		const bare = await run(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "@notes/verdict.md"}),
		});
		expect(bare.code).toBe(BARE_AT_PATH);

		const leaked = await run(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "see /Users/someone/scratch/notes.md"}),
		});
		expect(leaked.code).toBe(LEAKED_PATH);
		expect(leaked.stderr.at(-1)).toContain("cite it repo-relative or by class root.");
	});

	it("scans the ASSEMBLED comment, so a leak in the clause cannot escape the predicate", async () => {
		const out = await run(happy(), {clause: "see /Users/someone/scratch/notes.md"});
		expect(out.code).toBe(LEAKED_PATH);
	});

	it("refuses an absent PR on 7 and a closed one on 7 with its own reason", async () => {
		expect((await run([[PULL, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		const closed = await run([[PULL, pull({state: "closed"})]]);
		expect(closed.code).toBe(ZERO_SCOPE);
		expect(closed.stderr.at(-1)).toBe(
			"review post: PR #4321 is closed — a verdict on a closed PR gates nothing.",
		);
	});

	it("refuses a failed precondition read on 11, with nothing posted", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), errOut("fatal: bad revision")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was posted");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("reports a failed write as 8 — UNKNOWN whether the verdict landed", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments()],
			[CREATE, errOut("gh: timeout")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN whether the verdict landed");
		expect(out.stderr.at(-1)).toContain("fabrika review verdicts 4321");
	});

	it("refuses on 9 when the read-back does not yield this marker (#3173)", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, commentBody("something else entirely")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("inspect comment 5154902211");
	});

	it("reads back from LIVE state — a garbled SHA on the PR reds even though the write returned ok", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, commentBody(`review-doc: PASS @ ${OLD_HEAD} — guide matches shipped behavior`)],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain(`sha ${OLD_HEAD}`);
	});

	it("composes the advisory carrier with a SHA-less first line and a Reviewed-head body line", async () => {
		const advisory = `review-doc: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${HEAD}\n\n${BODY}`;
		const shell = fakeShell([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, commentBody(advisory)],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPost({...options, carrier: "advisory", clause: "blocking-set PR (manual merge)"}),
				shell.layer,
			),
		);
		expect(out.code).toBe(0);
		const write = shell.calls.find((call) => CREATE.test(call)) ?? "";
		expect(write).toContain("review-doc: advisory");
		expect(write).toContain(`Reviewed-head: @ ${HEAD}`);
		expect(write).not.toContain(`advisory — ... @ ${HEAD}`);
	});

	it("edits the existing advisory comment on a re-post, and creates one when there is none", async () => {
		const advisoryFor = (sha: string): string =>
			`review-doc: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${sha}\n\n${BODY}`;
		const advisoryOptions = {
			...options,
			carrier: "advisory",
			clause: "blocking-set PR (manual merge)",
		};

		const fresh = fakeShell([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments()],
			[CREATE, created],
			[READBACK, commentBody(advisoryFor(HEAD))],
		]);
		const first = await Effect.runPromise(Effect.provide(runPost(advisoryOptions), fresh.layer));
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("\tcreated\t");

		const again = fakeShell([
			[PULL, pull({comments: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments({id: 42, body: advisoryFor(OLD_HEAD), author: "kampus-bot"})],
			[PATCH, okOut(JSON.stringify({html_url: URL}))],
			[READBACK, commentBody(advisoryFor(HEAD))],
		]);
		const repost = await Effect.runPromise(Effect.provide(runPost(advisoryOptions), again.layer));
		expect(repost.code).toBe(0);
		expect(repost.stdout).toContain("\tedited\t");
		expect(again.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("never crosses the carriers: a marker post skips an advisory comment, and the reverse", async () => {
		const advisory = `review-doc: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${OLD_HEAD}\n\n${BODY}`;
		const overAdvisory = fakeShell([
			[PULL, pull({comments: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments({id: 42, body: advisory, author: "kampus-bot"})],
			[CREATE, created],
			[READBACK, commentBody(`${MARKER}\n\n${BODY}`)],
		]);
		const marker = await Effect.runPromise(Effect.provide(runPost(options), overAdvisory.layer));
		expect(marker.stdout).toContain("\tcreated\t");
		expect(overAdvisory.calls.some((call) => PATCH.test(call))).toBe(false);

		const overMarker = fakeShell([
			[PULL, pull({comments: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[
				COMMENTS,
				comments({
					id: 42,
					body: `review-doc: PASS @ ${OLD_HEAD} — older round`,
					author: "kampus-bot",
				}),
			],
			[CREATE, created],
			[
				READBACK,
				commentBody(
					`review-doc: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${HEAD}\n\n${BODY}`,
				),
			],
		]);
		const advisoryPost = await Effect.runPromise(
			Effect.provide(
				runPost({...options, carrier: "advisory", clause: "blocking-set PR (manual merge)"}),
				overMarker.layer,
			),
		);
		expect(advisoryPost.stdout).toContain("\tcreated\t");
		expect(overMarker.calls.some((call) => PATCH.test(call))).toBe(false);
	});

	it("emits the record with --json", async () => {
		const out = await run(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "posted",
			namespace: "review-doc",
			polarity: "PASS",
			sha: HEAD,
			upsert: "created",
			carrier: "marker",
		});
	});

	it("refuses a blank clause and a non-SHA --sha on 10, before any read", async () => {
		const shell = fakeShell(happy());
		const blank = await Effect.runPromise(
			Effect.provide(runPost({...options, clause: "  "}), shell.layer),
		);
		expect(blank.code).toBe(OFF_VOCABULARY);
		expect((await run(happy(), {sha: "nothex"})).code).toBe(OFF_VOCABULARY);
		expect(shell.calls).toEqual([]);
	});

	it("uses `once` to prove the read-back is a SECOND fetch, not the write's echo", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
			[FILES, files("skills/deploy/SKILL.md")],
			[USER, okOut("kampus-bot")],
			[COMMENTS, comments()],
			[CREATE, created],
			[once(READBACK), commentBody(`${MARKER}\n\n${BODY}`)],
			[READBACK, errOut("never reached")],
		]);
		expect(out.code).toBe(0);
	});
});

/**
 * The provenance fence (#5122).
 *
 * The derived namespace set is documented as both floor and ceiling for what this verb may emit, so
 * recomputing it from the PR-number endpoint admits a namespace this run never derived and refuses
 * one it did — and it does so at exit 0, with a posted verdict. `12` labels the tree the verdict
 * claims; only the binding makes the set provably that tree's.
 */
describe("runPost recomputes its namespace set at the bound commit", () => {
	it("derives the set from the bound commit, never from the PR-number endpoint", async () => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ --name-only -z ${BASE}...${HEAD}`,
		);
		expect(shell.calls.some((call) => call.includes("pulls/4321/files"))).toBe(false);
	});

	// The fail-OPEN direction: `review-skill` is derived only by the endpoint's list, so an unbound
	// recompute POSTS it — a verdict filling a namespace this run never judged, at exit 0.
	it("refuses a namespace only the unbound endpoint derives, and writes nothing", async () => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runPost({...options, namespace: "review-skill"}), shell.layer),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review post: --namespace review-skill is not derived by #4321's diff (present: review-code, review-doc) — a gate never emits a namespace it did not judge.",
		);
		expect(shell.calls.some((call) => CREATE.test(call) || PATCH.test(call))).toBe(false);
	});

	// The hole `12` cannot close, and the reason binding had to be added underneath it rather than
	// swapped in for it: the head moved forward and was force-pushed back onto the recorded SHA, so
	// the live head prefix-matches `--sha` and step 1 passes clean — while the PR-number endpoint
	// still answers with the intermediate head's file list.
	it("derives the REWOUND commit's set even though the live head matches --sha", async () => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runPost({...options, namespace: "review-doc"}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(`\t${HEAD}\t`);
		expect(shell.calls.some((call) => call.includes("pulls/4321/files"))).toBe(false);
	});

	it("names the commit the set was derived at on stderr", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe(
			`review post: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
	});

	it("refuses on 11 when the commit cannot be bound, rather than deriving an unbound set", async () => {
		const shell = fakeShell([
			[PULL, pull()],
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
			[FILES, files("skills/deploy/SKILL.md")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(shell.calls.some((call) => CREATE.test(call) || PATCH.test(call))).toBe(false);
	});

	// The `12` seat is `review post`'s own, ahead of the binding — the binding is added underneath it.
	it("keeps the 12 refusal on a forward-moved head, before any commit is bound", async () => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runPost({...options, sha: OLD_HEAD}), shell.layer),
		);
		expect(out.code).toBe(STALE_HEAD);
		expect(shell.calls.some((call) => call.startsWith("git diff"))).toBe(false);
	});
});
