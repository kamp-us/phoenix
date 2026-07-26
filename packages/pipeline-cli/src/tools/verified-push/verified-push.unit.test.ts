import {describe, expect, it} from "vitest";
import {
	decidePush,
	EXIT_CODE,
	type PushAttempt,
	type PushFacts,
	parseLsRemote,
	type RefProbe,
	VERDICT_PREFIX,
} from "./verified-push.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const REF = "refs/heads/umut/some-branch";

const clean: PushAttempt = {exitCode: 0, signal: null};

const attempted = (after: RefProbe, attempt: PushAttempt = clean): PushFacts => ({
	kind: "attempted",
	remote: "origin",
	ref: REF,
	expectedSha: HEAD,
	attempt,
	after,
});

/** The terminal line is the wire format: exactly one line, starting with the grep token. */
const expectTerminalLine = (line: string, token: string) => {
	expect(line.split("\n")).toHaveLength(1);
	expect(line.startsWith(`${VERDICT_PREFIX} ${token} `)).toBe(true);
};

describe("decidePush — the three outcomes", () => {
	it("MOVED only on positive evidence: the probe resolved the ref at the local head after a clean push", () => {
		const v = decidePush(attempted({kind: "resolved", sha: HEAD}));
		expect(v.outcome).toBe("moved");
		expect(v.exitCode).toBe(0);
		expectTerminalLine(v.terminalLine, "MOVED");
		expect(v.terminalLine).toContain(`observed=${HEAD}`);
	});

	it("NOT-MOVED when the remote ref does not exist after the push", () => {
		const v = decidePush(attempted({kind: "absent"}, {exitCode: 1, signal: null}));
		expect(v.outcome).toBe("not-moved");
		expect(v.exitCode).toBe(1);
		expectTerminalLine(v.terminalLine, "NOT-MOVED");
	});

	it("NOT-MOVED when the remote ref exists but carries a different commit", () => {
		const v = decidePush(attempted({kind: "resolved", sha: OTHER}));
		expect(v.outcome).toBe("not-moved");
		expect(v.terminalLine).toContain(`observed=${OTHER}`);
	});

	it("UNKNOWN when the ref probe could not execute — never collapsed into success", () => {
		const v = decidePush(attempted({kind: "failed", detail: "ls-remote timed out"}));
		expect(v.outcome).toBe("unknown");
		expect(v.exitCode).toBe(EXIT_CODE.unknown);
		expect(v.exitCode).not.toBe(EXIT_CODE.moved);
		expectTerminalLine(v.terminalLine, "UNKNOWN");
		expect(v.reason).toContain("could not execute");
	});

	it("UNKNOWN when no push was attempted at all (detached HEAD, unresolvable head, not a repo)", () => {
		const v = decidePush({kind: "not-attempted", detail: "HEAD is detached"});
		expect(v.outcome).toBe("unknown");
		expectTerminalLine(v.terminalLine, "UNKNOWN");
	});

	it("UNKNOWN when the ref matches but the push itself did not run cleanly — the match is not attributed", () => {
		const v = decidePush(attempted({kind: "resolved", sha: HEAD}, {exitCode: 128, signal: null}));
		expect(v.outcome).toBe("unknown");
		expect(v.reason).toContain("cannot attribute");
	});
});

describe("decidePush — the masked-failure shapes this exists to catch", () => {
	// The #4146 signature: a SIGPIPE'd git prints nothing and, piped through `tail`, reports 0.
	// The verdict must not depend on the push's self-report at all.
	it("a SIGPIPE'd push whose ref did not land is NOT-MOVED, whatever it reported", () => {
		const v = decidePush(attempted({kind: "absent"}, {exitCode: null, signal: "SIGPIPE"}));
		expect(v.outcome).toBe("not-moved");
		expect(v.reason).toContain("SIGPIPE");
	});

	it("an exit-0 push whose ref did not land is still NOT-MOVED (exit status is not the fact)", () => {
		const v = decidePush(attempted({kind: "absent"}, clean));
		expect(v.outcome).toBe("not-moved");
	});

	it("an undeterminable exit status with a confirmed landed ref is UNKNOWN, not MOVED", () => {
		const v = decidePush(attempted({kind: "resolved", sha: HEAD}, {exitCode: null, signal: null}));
		expect(v.outcome).toBe("unknown");
	});
});

describe("the terminal line — the channel that survives a pipe and a detached read", () => {
	it("every outcome emits exactly one greppable line carrying its own token", () => {
		const lines = [
			decidePush(attempted({kind: "resolved", sha: HEAD})).terminalLine,
			decidePush(attempted({kind: "absent"})).terminalLine,
			decidePush(attempted({kind: "failed", detail: "boom"})).terminalLine,
		];
		expect(lines.map((l) => l.split(" ")[1])).toEqual(["MOVED", "NOT-MOVED", "UNKNOWN"]);
		for (const l of lines) expect(l.split("\n")).toHaveLength(1);
	});

	it("a multi-line probe detail is collapsed so the terminal line stays a single line", () => {
		const v = decidePush(attempted({kind: "failed", detail: "fatal: could not read\nfrom remote"}));
		expect(v.terminalLine.split("\n")).toHaveLength(1);
		expect(v.terminalLine).toContain("could not read from remote");
	});

	it("the three tokens are mutually distinguishable by a whole-token grep", () => {
		const moved = decidePush(attempted({kind: "resolved", sha: HEAD})).terminalLine;
		// NOT-MOVED contains "MOVED" as a substring, so the token must be matched with its
		// prefix — the skill greps `PUSH-VERDICT: MOVED`, which the NOT-MOVED line never matches.
		const notMoved = decidePush(attempted({kind: "absent"})).terminalLine;
		expect(notMoved.includes(`${VERDICT_PREFIX} MOVED`)).toBe(false);
		expect(moved.includes(`${VERDICT_PREFIX} MOVED`)).toBe(true);
	});
});

describe("parseLsRemote", () => {
	it("reads the sha for the exact ref", () => {
		expect(parseLsRemote(`${HEAD}\t${REF}\n`, REF)).toBe(HEAD);
	});

	it("returns null when the ref is absent from the output", () => {
		expect(parseLsRemote("", REF)).toBeNull();
		expect(parseLsRemote(`${HEAD}\trefs/heads/other\n`, REF)).toBeNull();
	});

	it("does not match a ref that merely shares a prefix", () => {
		expect(parseLsRemote(`${HEAD}\t${REF}-suffix\n`, REF)).toBeNull();
	});

	it("ignores a malformed sha rather than reporting a bogus ref value", () => {
		expect(parseLsRemote(`not-a-sha\t${REF}\n`, REF)).toBeNull();
	});
});
