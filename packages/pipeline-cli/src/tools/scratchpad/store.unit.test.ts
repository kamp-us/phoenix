/**
 * The store's filesystem behaviour — and the #3718 regression it exists to hold: a
 * concurrent-run scenario that previously clobbered a shared scratchpad file must never
 * read back another run's content.
 *
 * These run against a real temp directory (no subprocess), so they are fast and
 * deterministic under parallel load.
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, assert, beforeEach, describe, it} from "@effect/vitest";
import {openNamespace, resolveOwnFile, resolveOwnNamespace} from "./store.ts";

// Synthetic run identities — never a real machine/session value in a fixture (#4018).
const REVIEWER_A = {session: "aaaaaaaa-0000-4000-8000-00000000000a", pid: "1001"};
const REVIEWER_B = {session: "bbbbbbbb-0000-4000-8000-00000000000b", pid: "1002"};

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "scratchpad-test-"));
});

afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const input = (run: {session: string; pid: string}, slug: string) => ({
	tmpdir: root,
	session: run.session,
	pid: run.pid,
	slug,
});

const pathOf = (resolved: ReturnType<typeof openNamespace>): string => {
	assert.isTrue(resolved.ok, "expected the namespace to resolve");
	return resolved.ok ? resolved.value.path : "";
};

describe("openNamespace", () => {
	it("creates the namespace and stamps it as ours", () => {
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		assert.isTrue(existsSync(path));
		assert.isTrue(resolveOwnNamespace(input(REVIEWER_A, "review-doc-3951")).ok);
	});

	it("clears leftovers nobody claimed — an unstamped directory is a dead run's residue", () => {
		const stale = join(root, "kampus-run", REVIEWER_A.session, "review-doc-3951");
		mkdirSync(stale, {recursive: true});
		writeFileSync(join(stale, "verdict-doc.md"), "stale body from a run that never stamped");
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		assert.isFalse(existsSync(join(path, "verdict-doc.md")));
	});

	it("re-opening this run's OWN namespace returns it as it stands, destroying nothing", () => {
		// The claim is exclusive, so the loser of a race lands here — and a peer this run
		// cannot tell apart from itself must not be able to delete the holder's state.
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		writeFileSync(join(path, "verdict-doc.md"), "PASS @ 167a195c");
		assert.isTrue(openNamespace(input(REVIEWER_A, "review-doc-3951")).ok);
		assert.strictEqual(readFileSync(join(path, "verdict-doc.md"), "utf8"), "PASS @ 167a195c");
	});

	it("refuses a namespace another run owns instead of clobbering it", () => {
		// Same session id, different run: the residual case a per-session scratchpad cannot
		// separate. The refusal is what makes the clobber loud instead of silent (#3718).
		openNamespace(input(REVIEWER_A, "review-doc-3951"));
		const second = openNamespace(input({...REVIEWER_A, pid: "9999"}, "review-doc-3951"));
		assert.isFalse(second.ok);
		if (!second.ok) assert.strictEqual(second.error._tag, "ForeignNamespace");
	});

	it("leaves the owner's namespace untouched when it refuses", () => {
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		writeFileSync(join(path, "verdict-doc.md"), "PASS @ 167a195c");
		openNamespace(input({...REVIEWER_A, pid: "9999"}, "review-doc-3951"));
		assert.strictEqual(readFileSync(join(path, "verdict-doc.md"), "utf8"), "PASS @ 167a195c");
		assert.isTrue(resolveOwnNamespace(input(REVIEWER_A, "review-doc-3951")).ok);
	});

	it("refuses a claim whose stamp cannot be read rather than assuming it is ours", () => {
		const claimed = join(root, "kampus-run", REVIEWER_A.session, "review-doc-3951");
		mkdirSync(claimed, {recursive: true});
		writeFileSync(join(claimed, ".kampus-run-owner"), "not json");
		const resolved = openNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "NamespaceUnavailable");
	});

	it("refuses a zero-length stamp too — an empty claim is corrupt, never an invitation", () => {
		// The claim is published atomically (#4864), so the stamp can no longer be empty because a
		// peer is mid-write. An empty one is therefore real residue, and reading it as "unowned"
		// would turn the fix for a wrong exit code into a fail-open.
		const claimed = join(root, "kampus-run", REVIEWER_A.session, "review-doc-3951");
		mkdirSync(claimed, {recursive: true});
		writeFileSync(join(claimed, ".kampus-run-owner"), "");
		const resolved = openNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "NamespaceUnavailable");
	});

	it("refuses with MissingSessionId rather than allocating a shared path", () => {
		const resolved = openNamespace({
			tmpdir: root,
			session: "",
			pid: "1001",
			slug: "review-doc-3951",
		});
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "MissingSessionId");
	});

	it("refuses when the filesystem will not give us the namespace", () => {
		// A regular file where the session directory must go — the create cannot succeed, and
		// the tool must surface that rather than degrade to somewhere writable.
		mkdirSync(join(root, "kampus-run"), {recursive: true});
		writeFileSync(join(root, "kampus-run", REVIEWER_A.session), "not a dir");
		const resolved = openNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "NamespaceUnavailable");
	});
});

describe("resolveOwnNamespace — the later-Bash-call re-derive", () => {
	it("recomputes the opened namespace and finds this run's files still there", () => {
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		writeFileSync(join(path, "verdict-doc.md"), "PASS @ 167a195c");
		const rederived = resolveOwnNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isTrue(rederived.ok);
		if (rederived.ok)
			assert.strictEqual(
				readFileSync(join(rederived.value.path, "verdict-doc.md"), "utf8"),
				"PASS @ 167a195c",
			);
	});

	it("refuses when this run never opened it — never creates a fresh empty directory", () => {
		const resolved = resolveOwnNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "NamespaceMissing");
	});

	it("refuses an unstamped directory — an unproven namespace is not this run's state", () => {
		mkdirSync(join(root, "kampus-run", REVIEWER_A.session, "review-doc-3951"), {recursive: true});
		const resolved = resolveOwnNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "NamespaceMissing");
	});

	it("refuses to read a namespace another run has taken over", () => {
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		// Simulate the takeover the owner stamp is there to catch.
		writeFileSync(
			join(path, ".kampus-run-owner"),
			JSON.stringify({session: REVIEWER_B.session, pid: REVIEWER_B.pid}),
		);
		const resolved = resolveOwnNamespace(input(REVIEWER_A, "review-doc-3951"));
		assert.isFalse(resolved.ok);
		if (!resolved.ok) assert.strictEqual(resolved.error._tag, "ForeignNamespace");
	});
});

describe("resolveOwnFile", () => {
	it("names a leaf inside this run's namespace", () => {
		const path = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		const file = resolveOwnFile(input(REVIEWER_A, "review-doc-3951"), "verdict-doc.md");
		assert.isTrue(file.ok);
		if (file.ok) assert.strictEqual(file.value, join(path, "verdict-doc.md"));
	});

	it("refuses a leaf name that walks out of the namespace", () => {
		openNamespace(input(REVIEWER_A, "review-doc-3951"));
		const file = resolveOwnFile(input(REVIEWER_A, "review-doc-3951"), "../verdict-doc.md");
		assert.isFalse(file.ok);
		if (!file.ok) assert.strictEqual(file.error._tag, "InvalidLeafName");
	});
});

describe("#3718 regression — concurrent reviewers on different PRs", () => {
	it("the shared-directory convention clobbers: the victim reads back the other PR's body", () => {
		// The failure being fixed, reproduced on the surface that caused it: one session-scoped
		// directory plus a generic leaf name. Nothing errors — the wrong content just reads back.
		const shared = join(root, "session-scratchpad");
		mkdirSync(shared, {recursive: true});
		writeFileSync(join(shared, "verdict-doc.md"), "PR 3951 · PASS @ 167a195c");
		writeFileSync(join(shared, "verdict-doc.md"), "PR 3955 · PASS @ 05de8f09");
		assert.strictEqual(
			readFileSync(join(shared, "verdict-doc.md"), "utf8"),
			"PR 3955 · PASS @ 05de8f09",
		);
	});

	it("per-run namespaces do not: each reviewer reads back its OWN verdict body", () => {
		const a = pathOf(openNamespace(input(REVIEWER_A, "review-doc-3951")));
		const b = pathOf(openNamespace(input(REVIEWER_B, "review-doc-3955")));
		assert.notStrictEqual(a, b);

		// Interleave the way two live gates do: A opens and writes, B opens and writes over the
		// same LEAF name, then A re-derives and reads.
		writeFileSync(join(a, "verdict-doc.md"), "PR 3951 · PASS @ 167a195c");
		writeFileSync(join(b, "verdict-doc.md"), "PR 3955 · PASS @ 05de8f09");

		const rederivedA = resolveOwnFile(input(REVIEWER_A, "review-doc-3951"), "verdict-doc.md");
		const rederivedB = resolveOwnFile(input(REVIEWER_B, "review-doc-3955"), "verdict-doc.md");
		assert.isTrue(rederivedA.ok && rederivedB.ok);
		if (rederivedA.ok)
			assert.strictEqual(readFileSync(rederivedA.value, "utf8"), "PR 3951 · PASS @ 167a195c");
		if (rederivedB.ok)
			assert.strictEqual(readFileSync(rederivedB.value, "utf8"), "PR 3955 · PASS @ 05de8f09");
	});

	it("neither reviewer can even name the other's namespace", () => {
		openNamespace(input(REVIEWER_A, "review-doc-3951"));
		openNamespace(input(REVIEWER_B, "review-doc-3955"));
		// B's slug resolved under A's session is a different (unopened) path, so an accidental
		// cross-wire fails loud rather than handing over the other run's files.
		const crossed = resolveOwnNamespace(input(REVIEWER_A, "review-doc-3955"));
		assert.isFalse(crossed.ok);
		if (!crossed.ok) assert.strictEqual(crossed.error._tag, "NamespaceMissing");
	});
});
