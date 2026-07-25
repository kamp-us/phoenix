import {assert, describe, it} from "@effect/vitest";
import {
	classifyOwnership,
	exitCodeFor,
	formatOwner,
	OWNER_FILE,
	parseOwner,
	type RunIdentity,
	resolveNamespace,
	tempRoot,
	validateLeafName,
	validateSlug,
} from "./scratchpad.ts";

// Synthetic run identities — never a real machine/session value in a fixture (#4018).
const SESSION_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SESSION_B = "bbbbbbbb-0000-4000-8000-00000000000b";

const namespaceOf = (over: {session?: string; pid?: string; slug?: string} = {}) => {
	const resolved = resolveNamespace({
		tmpdir: "/scratch",
		session: SESSION_A,
		slug: "review-doc-3951",
		...over,
	});
	assert.isTrue(resolved.ok, "expected the namespace to resolve");
	return resolved.ok ? resolved.value : undefined;
};

describe("resolveNamespace — deterministic and per-run", () => {
	it("keys the path on the run's session id and the caller's slug", () => {
		assert.strictEqual(namespaceOf()?.path, `/scratch/kampus-run/${SESSION_A}/review-doc-3951`);
	});

	it("recomputes the SAME path from the same inputs — the re-derive across Bash calls", () => {
		// Shell state does not survive between an agent's Bash calls, so the later call has to
		// recompute the path from scratch. That is the property a bare `mktemp -d` destroys.
		assert.strictEqual(namespaceOf()?.path, namespaceOf()?.path);
	});

	it("two concurrent runs never resolve the same path — different sessions", () => {
		assert.notStrictEqual(namespaceOf()?.path, namespaceOf({session: SESSION_B})?.path);
	});

	it("two gates over different PRs never resolve the same path — different slugs", () => {
		assert.notStrictEqual(namespaceOf()?.path, namespaceOf({slug: "review-doc-3955"})?.path);
	});

	it("puts the owner stamp at the namespace root", () => {
		assert.strictEqual(namespaceOf()?.ownerFile, `${namespaceOf()?.path}/${OWNER_FILE}`);
	});

	it("carries the pid when the environment exports one, null when it does not", () => {
		assert.strictEqual(namespaceOf({pid: "4242"})?.identity.pid, "4242");
		assert.strictEqual(namespaceOf()?.identity.pid, null);
	});
});

describe("resolveNamespace — fail closed, never a shared fallback", () => {
	it("refuses with MissingSessionId when the session id is absent", () => {
		const resolved = resolveNamespace({tmpdir: "/scratch", slug: "write-code-3718"});
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "MissingSessionId");
	});

	it("refuses a whitespace-only session id the same way", () => {
		const resolved = resolveNamespace({
			tmpdir: "/scratch",
			session: "   ",
			slug: "write-code-3718",
		});
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "MissingSessionId");
	});

	it("falls back to /tmp only for the TEMP ROOT — never for the run namespace itself", () => {
		assert.strictEqual(tempRoot(undefined), "/tmp");
		assert.strictEqual(tempRoot("/scratch/"), "/scratch");
	});
});

describe("validateSlug / validateLeafName — a slug can never escape its directory", () => {
	for (const bad of ["", "  ", "..", ".", "review/../3955", "review doc", "Review-Doc", "/abs"]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			const resolved = validateSlug(bad);
			assert.isFalse(resolved.ok);
			if (!resolved.ok) assert.strictEqual(resolved.error._tag, "InvalidSlug");
		});
	}

	it("accepts a plain skill-plus-work-item slug", () => {
		const resolved = validateSlug(" review-doc-3951 ");
		assert.isTrue(resolved.ok);
		if (resolved.ok) assert.strictEqual(resolved.value, "review-doc-3951");
	});

	it("rejects a leaf name that walks out of the namespace", () => {
		const resolved = validateLeafName("../verdict.md");
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "InvalidLeafName");
	});

	it("keeps ordinary leaf names — uniqueness lives in the directory, not the file name", () => {
		assert.isTrue(validateLeafName("verdict-doc.md").ok);
	});
});

describe("owner stamp round-trip", () => {
	const identity: RunIdentity = {session: SESSION_A, pid: "4242"};

	it("parses back what it formatted", () => {
		assert.deepStrictEqual(parseOwner(formatOwner(identity, "2026-07-25T00:00:00.000Z")), identity);
	});

	it("reads a pid-less stamp as pid null", () => {
		const parsed = parseOwner(
			formatOwner({session: SESSION_A, pid: null}, "2026-07-25T00:00:00.000Z"),
		);
		assert.deepStrictEqual(parsed, {session: SESSION_A, pid: null});
	});

	it("treats an unreadable stamp as no owner at all", () => {
		assert.isNull(parseOwner("not json"));
		assert.isNull(parseOwner("{}"));
		assert.isNull(parseOwner('{"session":"  "}'));
	});
});

describe("classifyOwnership — positive evidence only", () => {
	const mine: RunIdentity = {session: SESSION_A, pid: "4242"};

	it("no stamp ⇒ unowned", () => {
		assert.strictEqual(classifyOwnership(null, mine), "unowned");
	});

	it("same session and pid ⇒ mine", () => {
		assert.strictEqual(classifyOwnership({session: SESSION_A, pid: "4242"}, mine), "mine");
	});

	it("another session ⇒ foreign", () => {
		assert.strictEqual(classifyOwnership({session: SESSION_B, pid: "4242"}, mine), "foreign");
	});

	it("SAME session, different pid ⇒ foreign — the two-runs-share-a-session case", () => {
		// Calling this one "mine" is what a silent clobber looks like: two live runs would both
		// treat the namespace as theirs and overwrite each other's files (#3718).
		assert.strictEqual(classifyOwnership({session: SESSION_A, pid: "9999"}, mine), "foreign");
	});

	it("a stamp with a pid vs a run without one ⇒ foreign (fail closed on the ambiguity)", () => {
		assert.strictEqual(
			classifyOwnership({session: SESSION_A, pid: "4242"}, {session: SESSION_A, pid: null}),
			"foreign",
		);
	});

	it("neither side has a pid ⇒ mine (the session id is the run identity)", () => {
		assert.strictEqual(
			classifyOwnership({session: SESSION_A, pid: null}, {session: SESSION_A, pid: null}),
			"mine",
		);
	});
});

describe("exitCodeFor — a caller branches on status, not prose", () => {
	it("maps each refusal to its own code", () => {
		assert.strictEqual(exitCodeFor({_tag: "MissingSessionId", message: ""}), 2);
		assert.strictEqual(exitCodeFor({_tag: "InvalidSlug", slug: "", message: ""}), 3);
		assert.strictEqual(exitCodeFor({_tag: "InvalidLeafName", name: "", message: ""}), 3);
		assert.strictEqual(
			exitCodeFor({
				_tag: "ForeignNamespace",
				path: "/scratch",
				owner: {session: SESSION_B, pid: null},
				mine: {session: SESSION_A, pid: null},
				message: "",
			}),
			4,
		);
		assert.strictEqual(exitCodeFor({_tag: "NamespaceMissing", path: "/scratch", message: ""}), 5);
		assert.strictEqual(
			exitCodeFor({_tag: "NamespaceUnavailable", path: "/scratch", message: ""}),
			6,
		);
	});
});
