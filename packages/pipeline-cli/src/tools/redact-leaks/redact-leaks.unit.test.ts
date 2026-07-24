import {assert, describe, it} from "@effect/vitest";
import {findCommentLeaks} from "../leak-guard/leak-guard.ts";
import {redactLeaks} from "./redact-leaks.ts";

// The invariant the whole tool serves: a redacted body carries NO leak the shared matcher
// (its single source) would still flag — REDACT to the point of clean, never leave a partial.
const isClean = (text: string): boolean => findCommentLeaks(text).length === 0;

describe("redactLeaks — REDACT matched leaks, preserving evidential shape (#3021 AC2)", () => {
	it("redacts a /var/folders mktemp path to its class-root, dropping the user-hash/temp-filename", () => {
		const out = redactLeaks("posted as the body: @/var/folders/zz/9abc1x/T/tmp.Qk29Vd");
		assert.strictEqual(out, "posted as the body: @/var/folders/<redacted>");
		// evidential shape survives (still shows a temp path was here), and it is clean
		assert.include(out, "/var/folders/");
		assert.isTrue(isClean(out));
	});

	it("redacts an absolute /Users/<name> home path, keeping the /Users root", () => {
		const out = redactLeaks("see /Users/umut/code/phoenix/apps/web for the seam");
		assert.strictEqual(out, "see /Users/<redacted>/code/phoenix/apps/web for the seam");
		assert.isTrue(isClean(out));
	});

	it("redacts a /private/tmp resolved temp root, keeping /private/tmp", () => {
		const out = redactLeaks("wrote /private/tmp/claude-501/scratch/verdict.md");
		assert.strictEqual(out, "wrote /private/tmp/<redacted>");
		assert.isTrue(isClean(out));
	});

	it("redacts a bare /tmp scratch path, keeping /tmp", () => {
		const out = redactLeaks("scratch at /tmp/triage-original-3019.md here");
		assert.strictEqual(out, "scratch at /tmp/<redacted> here");
		assert.isTrue(isClean(out));
	});

	it("redacts a ~/.claude private-home internal down to ~, dropping the tool name", () => {
		// A descent into the private agent-home tree is still a leak — only the two public
		// config leaves were exempted by shape (#3475); ~/.claude/projects/... is not one.
		const out = redactLeaks("edit ~/.claude/projects/foo/session.json please");
		assert.strictEqual(out, "edit ~/<redacted>/projects/foo/session.json please");
		assert.isTrue(isClean(out));
	});

	it("redacts a ~/code sibling-repo clone, keeping the trailing slash", () => {
		const out = redactLeaks("rebuilt from ~/code/github.com/kamp-us/kampus");
		assert.strictEqual(out, "rebuilt from ~/<redacted>/github.com/kamp-us/kampus");
		assert.isTrue(isClean(out));
	});

	it("redacts a generic (non-~/code) home-root sibling clone, keeping ~ and the forge tail (#3401)", () => {
		// The #3401 matcher flags clones under ANY home root; the generic arm consumes only the
		// `~/<root>/` prefix (lookahead tail), so the redactor masks just the home root and preserves
		// the `<host>/<user>/<repo>` evidential shape — same as the `~/code/` case above.
		const out = redactLeaks("grounded in ~/dev/github.com/usirin/effect-smol");
		assert.strictEqual(out, "grounded in ~/<redacted>/github.com/usirin/effect-smol");
		assert.isTrue(isClean(out));
	});

	it("redacts a /vault path", () => {
		const out = redactLeaks("stored under /vault/secrets/key");
		assert.strictEqual(out, "stored under /<redacted>/secrets/key");
		assert.isTrue(isClean(out));
	});
});

describe("redactLeaks — no regression for leak-free text (#3021 AC5)", () => {
	it("returns leak-free text byte-for-byte unchanged", () => {
		const original =
			"See apps/web/worker and .claude/skills/report. A bare /tmp mention with no path is fine, and ~/.config passes.";
		assert.strictEqual(redactLeaks(original), original);
	});

	it("preserves an empty string", () => {
		assert.strictEqual(redactLeaks(""), "");
	});

	it("leaves the now-exempt public, machine-agnostic config leaves unredacted (#3475)", () => {
		// The detector (leak-guard.ts) narrowed the ~/.claude arm by shape to exempt these
		// public config files — they are no longer leaks, so the redactor, sharing the one
		// findCommentLeaks source, must return them byte-for-byte (the private-home internals
		// case above still redacts). Keeps redactor and detector contracts aligned.
		for (const safe of [
			"edit ~/.claude.json please",
			"edit ~/.claude/settings.json please",
			"see .mcp.json for the server list",
		]) {
			assert.strictEqual(redactLeaks(safe), safe);
		}
	});

	it("leaves a leak-free multi-line body with code fences byte-for-byte", () => {
		const body =
			"## Report\n\n```ts\nconst x = 1;\n```\n\nRepo-relative: packages/pipeline-cli/src.\n";
		assert.strictEqual(redactLeaks(body), body);
	});
});

describe("redactLeaks — multiple + overlapping leaks", () => {
	it("redacts every distinct leak in one body", () => {
		const out = redactLeaks("temp @/var/folders/zz/T/tmp.AB and home /Users/umut/x");
		assert.strictEqual(out, "temp @/var/folders/<redacted> and home /Users/<redacted>/x");
		assert.isTrue(isClean(out));
	});

	it("does not let a shorter match corrupt a longer overlapping one (/Users/foo vs /Users/foobar)", () => {
		const out = redactLeaks("/Users/foo and /Users/foobar");
		assert.strictEqual(out, "/Users/<redacted> and /Users/<redacted>");
		assert.isTrue(isClean(out));
	});
});
