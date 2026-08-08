import {describe, expect, it} from "vitest";
import type {StdinRead} from "../io/stdin.ts";
import {FAILED} from "../verb.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {BARE_AT_PATH, EMPTY_STDIN, LEAKED_PATH} from "./codes.ts";

const SURFACE: AuthoredSurface = {
	verb: "triage split",
	noun: "the child body",
	emptyHint: "pipe the child body in.",
};

const read = (r: StdinRead) => readAuthored(SURFACE, r);

describe("readAuthored", () => {
	it("passes authored text through with its byte count", () => {
		const out = read({_tag: "Text", text: "iki ünite"});
		expect(out).toMatchObject({_tag: "Text", text: "iki ünite"});
		// The count is bytes, not characters — `ü` is two.
		expect(out._tag === "Text" && out.bytes).toBe(10);
	});

	it("seats a FAILED read on 1, never on the empty code — an unread pipe is UNKNOWN", () => {
		const out = read({_tag: "Failed", reason: "EAGAIN"});
		expect(out._tag === "Refused" && out.outcome.code).toBe(FAILED);
		expect(out._tag === "Refused" && out.outcome.stderr.at(-1)).toContain("never empty");
	});

	it("refuses a read-but-empty pipe on its own code, and says what it read", () => {
		const out = read({_tag: "Text", text: ""});
		expect(out._tag === "Refused" && out.outcome.code).toBe(EMPTY_STDIN);
		expect(out._tag === "Refused" && out.outcome.stderr.at(-1)).toBe(
			"triage split: no body on stdin — pipe the child body in.",
		);
		expect(out._tag === "Refused" && out.outcome.stderr[0]).toContain("0 byte(s)");
	});

	it("treats whitespace-only text as empty", () => {
		expect(read({_tag: "Text", text: "  \n\t"})._tag).toBe("Refused");
	});

	it("treats a TTY as the same correctable state as an empty pipe", () => {
		const out = read({_tag: "NoStdin", reason: "fd 0 is a TTY"});
		expect(out._tag === "Refused" && out.outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses a bare @ reference on its own code — masking it would never terminate", () => {
		const out = read({_tag: "Text", text: "@/tmp/child.md"});
		expect(out._tag === "Refused" && out.outcome.code).toBe(BARE_AT_PATH);
		expect(out._tag === "Refused" && out.outcome.stderr.at(-1)).toContain("the body never arrived");
	});

	it("does not mistake an @mention for a path reference", () => {
		expect(read({_tag: "Text", text: "@usirin asked for this"})._tag).toBe("Text");
	});

	it("emits nothing on stdout on every refusal", () => {
		for (const r of [
			{_tag: "Failed", reason: "EAGAIN"},
			{_tag: "Text", text: ""},
			{_tag: "Text", text: "@/tmp/x.md"},
		] satisfies ReadonlyArray<StdinRead>) {
			const out = read(r);
			expect(out._tag === "Refused" && out.outcome.stdout).toBe("");
		}
	});
});

describe("leakRefusal", () => {
	it("passes a body carrying no machine-local path", () => {
		expect(leakRefusal(SURFACE, "see packages/fabrika-cli/src/triage/split.ts")).toBeNull();
	});

	it("refuses a machine-local path, naming the first hit's line and class", () => {
		const out = leakRefusal(SURFACE, "context\nreproduced from /Users/someone/scratch/case.md");
		expect(out?.code).toBe(LEAKED_PATH);
		expect(out?.stderr.at(-1)).toBe(
			"triage split: the child body carries a machine-local path at line 2 (absolute home root) — rewrite it repo-relative.",
		);
	});

	it("lists every hit above the message, not just the one it names", () => {
		const out = leakRefusal(SURFACE, "/tmp/a/b\n~/c/d");
		expect(out?.stderr).toEqual([
			"  line 1, temp root",
			"  line 2, home-relative",
			expect.stringContaining("line 1 (temp root)"),
		]);
	});

	it("offers no redaction — authored text is the author's to fix", () => {
		expect(leakRefusal(SURFACE, "/Users/someone/x")?.stdout).toBe("");
	});
});
