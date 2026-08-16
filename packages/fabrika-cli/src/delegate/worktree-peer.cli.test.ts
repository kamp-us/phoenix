/**
 * The end-to-end half of the worktree-peer delegation (#5679): a real process, invoked exactly the
 * way the defect is met.
 *
 * The copy on `PATH` is a `pnpm link --global` of the primary checkout, so an agent standing in a
 * worktree who types the bare `fabrika` invokes the *primary's* `bin.ts` with a cwd in another
 * working tree of the same repository. Only a spawn proves the copy on disk hands the invocation
 * over, because the delegation's whole failure mode is that both copies print the same bytes.
 *
 * The fixture points a scratch checkout's git plumbing at THIS checkout's real common dir, which is
 * what `git worktree add` does and what makes the two trees one repository. Its counterpart is
 * [`foreign-checkout.cli.test.ts`](./foreign-checkout.cli.test.ts), whose scratch tree shares no
 * repository and must still be refused.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");

/** What the peer working tree's install prints when it is allowed to answer — as it must be. */
const PEER = "answered-from-the-peer-working-tree";

/** This checkout's `$GIT_COMMON_DIR`, asked of git itself, or `undefined` outside a repository. */
const commonDirOfThisCheckout = (): string | undefined => {
	try {
		const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: CHECKOUT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return resolve(CHECKOUT, out.trim());
	} catch {
		return undefined;
	}
};

const commonDir = commonDirOfThisCheckout();

let peer: string;

beforeAll(() => {
	if (commonDir === undefined) return;
	const scratch = mkdtempSync(join(tmpdir(), "fabrika-peer-"));
	peer = join(scratch, "lane");
	const gitDir = join(scratch, "gitdir");
	const installed = join(peer, "node_modules", "@kampus", "fabrika-cli");
	mkdirSync(installed, {recursive: true});
	mkdirSync(gitDir, {recursive: true});
	// `commondir` is what makes this tree the same repository as the invoked copy's — the mechanism
	// `git worktree` uses, per `gitrepository-layout(5)`.
	writeFileSync(join(gitDir, "commondir"), `${commonDir}\n`);
	writeFileSync(join(peer, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(peer, "package.json"), '{"name":"lane","version":"0.0.0"}\n');
	writeFileSync(join(installed, "bin.js"), `console.log(${JSON.stringify(PEER)});\n`);
	writeFileSync(
		join(installed, "package.json"),
		'{"name":"@kampus/fabrika-cli","version":"9.9.9","bin":{"fabrika":"./bin.js"}}\n',
	);
});

afterAll(() => {
	if (peer !== undefined) rmSync(join(peer, ".."), {recursive: true, force: true});
});

const invokeFromPeer = (...args: ReadonlyArray<string>) => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			cwd: peer,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("invoking this checkout's bin from a cwd in another working tree of the same repository", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
	// The bin's own delegation is under test, so the guard that pins an invocation to this copy has
	// to stay unset — and vitest inherits the parent env. Outside a git repository the fixture
	// cannot be built at all, which is a missing fixture rather than a passing subject.
	skip: process.env.FABRIKA_SKIP_INFER !== undefined || commonDir === undefined,
}, () => {
	it("hands the invocation to the peer tree's own install rather than answering itself", () => {
		const run = invokeFromPeer("--version");
		expect(run.stdout).toContain(PEER);
		expect(run.code).toBe(0);
	});

	it("does not refuse — a working tree of this repository is not a foreign checkout", () => {
		expect(invokeFromPeer("--version").stderr).not.toContain("refusing to run");
	});

	it("still serves the invocation itself under --skip-infer — the guard outranks the walk", () => {
		const run = invokeFromPeer("--skip-infer", "--version");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("fabrika v");
		expect(run.stdout).not.toContain(PEER);
	});
});
