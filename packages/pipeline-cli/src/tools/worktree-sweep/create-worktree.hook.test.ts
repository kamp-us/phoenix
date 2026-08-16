/**
 * Golden real-payload guard for the WorktreeCreate hook script (create-worktree.sh,
 * #2924/ADR 0178) — retrofitted to the CAPTURED real payload per ADR 0180 (#2936).
 *
 * The handler is asserted against a committed golden fixture captured from a live spawn
 * (`__fixtures__/worktree-create.payload.golden.json`), never a hand-authored shape. #2925
 * shipped this hook built to an INFERRED `{ worktree_path, base_ref }` contract; the real
 * harness sends `{ session_id, transcript_path, cwd, prompt_id, agent_type, hook_event_name,
 * name }` and expects the path CONSTRUCTED as `<cwd>/.claude/worktrees/<name>`. The unit test
 * passed against the fabricated shape, so all three gates went green on a hook that fail-closed
 * on every spawn. These tests reproduce that catch: driving the golden payload through the
 * handler FAILS against the old `worktree_path` contract and passes only against the real one.
 *
 * As with command.hook.test.ts, this drives the REAL script against a REAL throwaway git repo.
 * The temp repo has NO lefthook config, so `git worktree add` here does NOT fire the phoenix
 * post-checkout `bootstrap-deps` install (that ~13s install, and the live 600s-budgeted harness
 * firing that motivates the whole hook, only reproduce on a real harness spawn). What IS
 * unit-testable is the script's PURE decision logic: stdin JSON parse → the path it constructs
 * from cwd+name → the git command it runs → the stdout path contract → the fail-closed exits.
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {loadGoldenPayload, readGoldenFixture} from "../../golden-fixture.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

const SCRIPT = fileURLToPath(
	new URL(
		"../../../../../claude-plugins/kampus-pipeline/hooks/create-worktree.sh",
		import.meta.url,
	),
);

const GOLDEN = "__fixtures__/worktree-create.payload.golden.json";

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

describe("create-worktree.sh — WorktreeCreate hook against the golden real payload (#2936/ADR 0180)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	let mainRepo: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"});

	// Every run redirects the #4180 invocation trace to a suite-scoped file, so the tests never
	// append to the shared default log the live forensic record lives in.
	let traceLog: string;

	// A private trace target, for any test that ASSERTS on trace content. The suite-scoped
	// `traceLog` is append-only and shared, so an `assert.include` over it is satisfied by any
	// earlier test's line — which made both #4180 trace assertions vacuous: `entry` was already
	// there from the first provisioning test, and `unknown pid=` from the jq-less test, whose
	// bindir carries no `date` and so already exercises the degradation. Own log ⇒ the assertion
	// observes only its own run and actually fails when the behaviour breaks.
	const freshTraceLog = (): string => join(mkdtempSync(join(tmpdir(), "wtc-trace-")), "trace.log");

	// Run the hook script with `payload` on stdin, cwd inside the repo — exactly as
	// Claude Code fires it. Never throws: a non-zero exit is captured, not raised.
	const run = (cwd: string, payload: string, logPath?: string): RunResult => {
		try {
			const stdout = execFileSync("bash", [SCRIPT], {
				cwd,
				input: payload,
				encoding: "utf8",
				env: {...process.env, KAMPUS_WORKTREE_HOOK_LOG: logPath ?? traceLog},
			});
			return {code: 0, stdout, stderr: ""};
		} catch (e) {
			const err = e as {status?: number; stdout?: string; stderr?: string};
			return {code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? ""};
		}
	};

	// A payload with the GOLDEN captured shape but this run's cwd + name. The shape (which
	// keys exist) comes wholly from the committed fixture — the fabrication-proof property —
	// while cwd/name are the only per-run values a fixed fixture cannot pin (the temp repo
	// path is materialized here). If the handler ever regresses to reading `worktree_path`,
	// the golden shape (which has none) drives the failure.
	const goldenPayloadFor = (cwd: string, name: string): string => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		return JSON.stringify({...golden, cwd, name});
	};

	beforeAll(() => {
		traceLog = freshTraceLog();
		mainRepo = mkdtempSync(join(tmpdir(), "wtc-main-"));
		git(mainRepo, "init", "-q", "-b", "main");
		git(mainRepo, "config", "user.email", "t@t.t");
		git(mainRepo, "config", "user.name", "t");
		writeFileSync(join(mainRepo, "README.md"), "x");
		git(mainRepo, "add", ".");
		git(mainRepo, "commit", "-q", "-m", "init");
		// The real payload carries no base_ref, so the hook defaults to origin/main — point
		// origin at self so origin/main resolves inside the throwaway repo.
		git(mainRepo, "remote", "add", "origin", mainRepo);
		git(mainRepo, "fetch", "-q", "origin");
	});

	afterAll(() => rmSync(mainRepo, {recursive: true, force: true}));

	// The #2925 lesson, encoded as the contract: the captured payload has name+cwd and
	// NEITHER worktree_path NOR base_ref. Asserting against the committed fixture is what makes
	// "the documented contract is wrong" a red test rather than a green false-confidence.
	it("the golden fixture is the REAL captured shape — name+cwd, no worktree_path, no base_ref", () => {
		const p = loadGoldenPayload(import.meta.url, GOLDEN);
		for (const key of [
			"session_id",
			"transcript_path",
			"cwd",
			"prompt_id",
			"agent_type",
			"hook_event_name",
			"name",
		]) {
			assert.property(p, key, `WorktreeCreate payload must carry \`${key}\``);
		}
		assert.strictEqual(p.hook_event_name, "WorktreeCreate");
		assert.match(String(p.name), /^agent-[0-9a-f]+$/, "name is the `agent-<hex>` worktree id");
		assert.isTrue(String(p.cwd).startsWith("/"), "cwd is an absolute repo path");
		assert.notProperty(p, "worktree_path", "the real payload does NOT carry worktree_path (#2925)");
		assert.notProperty(p, "base_ref", "the real payload does NOT carry base_ref (#2925)");
	});

	// The #2925 catch: driving the real payload constructs the path from cwd+name and prints
	// ONLY it. Against the OLD fabricated `worktree_path` handler this FAILS — the golden
	// payload has no worktree_path, so the old script fail-closes with a non-zero exit.
	it("constructs the path as <cwd>/.claude/worktrees/<name> and prints ONLY that path", () => {
		const name = "agent-deadbeef01";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		const {code, stdout} = run(mainRepo, goldenPayloadFor(mainRepo, name));
		assert.strictEqual(code, 0, "the real payload must provision, not fail-close");
		assert.strictEqual(
			stdout.trim(),
			expected,
			"stdout must be ONLY the constructed worktree path",
		);
		assert.isTrue(existsSync(expected), "the worktree must actually be created");
		assert.isTrue(
			existsSync(join(expected, "README.md")),
			"origin/main's tree must be checked out",
		);
	});

	it("parses correctly without jq (grep/sed fallback) — the same constructed path", () => {
		// Force the jq-less branch deterministically across OSes: run under `env -i` with a
		// PATH pointing at a bindir that has ONLY the tools the parse needs (bash + coreutils),
		// and crucially NO jq. The script parses under this PATH before it prepends the standard
		// toolchain dirs, so `command -v jq` genuinely misses and the grep/sed fallback runs.
		const bindir = mkdtempSync(join(tmpdir(), "wtc-nojq-bin-"));
		const which = (tool: string) =>
			execFileSync("bash", ["-lc", `command -v ${tool}`], {encoding: "utf8"}).trim();
		for (const tool of ["bash", "cat", "grep", "sed", "head", "git", "printf"]) {
			try {
				symlinkSync(which(tool), join(bindir, tool));
			} catch {
				/* printf is often a shell builtin with no binary — the parse still works without it */
			}
		}
		const name = "agent-nojqfa11";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		let stdout = "";
		let code = 0;
		try {
			stdout = execFileSync("bash", [SCRIPT], {
				cwd: mainRepo,
				input: goldenPayloadFor(mainRepo, name),
				encoding: "utf8",
				// env -i: PATH=bindir ONLY (jq-free — no /usr/bin, which carries jq on Linux) so
				// the parse deterministically takes the fallback; the script re-adds the standard
				// toolchain dirs AFTER parsing, so git still resolves for `worktree add`.
				env: {PATH: bindir, HOME: mainRepo, KAMPUS_WORKTREE_HOOK_LOG: traceLog},
			});
		} catch (e) {
			const err = e as {status?: number; stdout?: string};
			code = err.status ?? 1;
			stdout = err.stdout ?? "";
		} finally {
			rmSync(bindir, {recursive: true, force: true});
		}
		assert.strictEqual(code, 0);
		assert.strictEqual(
			stdout.trim(),
			expected,
			"the jq-less fallback must construct the same path",
		);
		assert.isTrue(existsSync(expected));
	});

	it("fail-closes (non-zero) when name is absent — never a silent no-op", () => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		const {name: _name, ...noName} = golden;
		const {code} = run(mainRepo, JSON.stringify({...noName, cwd: mainRepo}));
		assert.notStrictEqual(code, 0, "a payload with no name must be rejected");
	});

	it("fail-closes (non-zero) when cwd is absent — never a silent no-op", () => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		const {cwd: _cwd, ...noCwd} = golden;
		const {code} = run(mainRepo, JSON.stringify({...noCwd, name: "agent-nocwd001"}));
		assert.notStrictEqual(code, 0, "a payload with no cwd must be rejected");
	});

	it("fail-closes (non-zero) when the fetch fails (no origin → possibly-stale base) — #3621", () => {
		// A fresh repo with NO origin: the hook fetches origin/main BEFORE branching (#3621), so
		// the missing origin makes `git fetch origin main` fail → the hook fail-closes at the fetch
		// rather than silently branching from a possibly-stale base.
		const bare = mkdtempSync(join(tmpdir(), "wtc-noorigin-"));
		git(bare, "init", "-q", "-b", "main");
		git(bare, "config", "user.email", "t@t.t");
		git(bare, "config", "user.name", "t");
		writeFileSync(join(bare, "README.md"), "x");
		git(bare, "add", ".");
		git(bare, "commit", "-q", "-m", "init");
		const name = "agent-badbase01";
		const {code} = run(bare, goldenPayloadFor(bare, name));
		rmSync(bare, {recursive: true, force: true});
		assert.notStrictEqual(code, 0, "a failed fetch must fail-close, blocking creation");
	});

	// THE #3621 regression: reproduce the stale-local-main trap and prove the hook fetches fresh.
	// A consumer whose cached origin/main AND local main both predate a sibling lane's merge must
	// still base its new worktree on a tip that INCLUDES that merge — and must do so WITHOUT moving
	// the primary's local main (the #2143/#2144 primary-main-corruption constraint).
	it("fetches origin BEFORE branching so the base includes a sibling's just-merged commit, never moving local main (#3621)", () => {
		const originRepo = mkdtempSync(join(tmpdir(), "wtc-origin-"));
		git(originRepo, "init", "-q", "-b", "main");
		git(originRepo, "config", "user.email", "t@t.t");
		git(originRepo, "config", "user.name", "t");
		writeFileSync(join(originRepo, "README.md"), "x");
		git(originRepo, "add", ".");
		git(originRepo, "commit", "-q", "-m", "init");

		// Consumer tracks origin at the init commit — its origin/main AND local main both point there.
		const consumer = mkdtempSync(join(tmpdir(), "wtc-consumer-"));
		git(consumer, "init", "-q", "-b", "main");
		git(consumer, "config", "user.email", "t@t.t");
		git(consumer, "config", "user.name", "t");
		git(consumer, "remote", "add", "origin", originRepo);
		git(consumer, "fetch", "-q", "origin");
		git(consumer, "checkout", "-q", "-B", "main", "origin/main");
		const staleTip = git(consumer, "rev-parse", "main").trim();

		// A sibling lane merges to origin AFTER the consumer last fetched — the exact stale window.
		writeFileSync(join(originRepo, "sibling.txt"), "merged-by-sibling");
		git(originRepo, "add", ".");
		git(originRepo, "commit", "-q", "-m", "sibling merge");
		const freshTip = git(originRepo, "rev-parse", "HEAD").trim();

		const name = "agent-stale01";
		const expected = join(consumer, ".claude", "worktrees", name);
		const {code, stdout} = run(consumer, goldenPayloadFor(consumer, name));
		assert.strictEqual(code, 0, "the hook must provision, fetching fresh");
		assert.strictEqual(stdout.trim(), expected);

		const wtHead = git(expected, "rev-parse", "HEAD").trim();
		assert.strictEqual(
			wtHead,
			freshTip,
			"the worktree base must be the FRESH remote tip (fetched), not the stale local/origin main",
		);
		assert.isTrue(
			existsSync(join(expected, "sibling.txt")),
			"the sibling's just-merged file must be present in the base",
		);
		assert.notStrictEqual(wtHead, staleTip, "the base must NOT be the pre-merge stale tip");

		// The load-bearing no-corruption constraint: the fetch advances only remote-tracking refs,
		// never the primary's local main HEAD (#2143/#2144).
		const consumerLocalMain = git(consumer, "rev-parse", "main").trim();
		assert.strictEqual(
			consumerLocalMain,
			staleTip,
			"the hook must NOT move the primary's local main — only remote-tracking refs (#2143/#2144)",
		);

		rmSync(consumer, {recursive: true, force: true});
		rmSync(originRepo, {recursive: true, force: true});
	});

	// The producer half of the #3943 presence gate: the sweep can only ask "is this tree's owner
	// still running?" if creation recorded WHO owns it. The stamp must land in the git ADMIN dir,
	// never the working tree — an untracked file there would read as dirty and pin the tree forever.
	it("stamps the owning session into <gitdir>/kampus-owner.json, leaving the working tree clean (#3943)", () => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		const name = "agent-stamped001";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		const {code} = run(mainRepo, goldenPayloadFor(mainRepo, name));
		assert.strictEqual(code, 0);
		const gitdir = git(expected, "rev-parse", "--absolute-git-dir").trim();
		const stamp = JSON.parse(readFileSync(join(gitdir, "kampus-owner.json"), "utf8"));
		assert.strictEqual(
			stamp.sessionId,
			golden.session_id,
			"the stamp must carry the owning session",
		);
		assert.strictEqual(stamp.worktreeName, name);
		// #4001: the hook runs in the SPAWNING session, before the occupying subagent exists, so the
		// only honest kind it can record is `launcher`. A stamp that claimed `occupant` here would
		// hand a long-lived pane's liveness the authority to keep every tree it ever spawned.
		assert.strictEqual(
			stamp.ownerKind,
			"launcher",
			"a creation-time stamp names the launcher, never the occupant",
		);
		assert.strictEqual(
			git(expected, "status", "--porcelain").trim(),
			"",
			"the stamp must not dirty the working tree (a dirty tree is KEPT forever)",
		);
	});

	// Best-effort by design: an unstamped tree resolves owner-unknown, which the sweep KEEPS — so a
	// missing session_id may leak a tree but must never block a spawn.
	it("still provisions when the payload carries no session_id (unstamped ⇒ owner-unknown ⇒ never reaped)", () => {
		const golden = loadGoldenPayload(import.meta.url, GOLDEN);
		const {session_id: _sid, ...noSession} = golden;
		const name = "agent-nosession01";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		const {code, stdout} = run(mainRepo, JSON.stringify({...noSession, cwd: mainRepo, name}));
		assert.strictEqual(code, 0, "a missing session_id must not fail-close the spawn");
		assert.strictEqual(stdout.trim(), expected);
		const gitdir = git(expected, "rev-parse", "--absolute-git-dir").trim();
		assert.isFalse(existsSync(join(gitdir, "kampus-owner.json")));
	});

	// The #4180 forensic seam. Every other artifact this hook produces lands only AFTER
	// `git worktree add` succeeds, so "the harness never invoked the hook" and "it invoked the
	// hook and the hook died at its first line" are byte-identical on disk — which is why 272
	// registered worktrees with 0 stamps could not name their own cause. The entry line is
	// written before any parsing, so it separates the two.
	it("writes an entry trace BEFORE parsing — a payload it rejects still proves invocation (#4180)", () => {
		// Private log: the only line that can satisfy this assertion is the one this rejected
		// payload wrote. Relocate `trace "entry"` below the fail-closed exit and the log is empty.
		const log = freshTraceLog();
		const {code} = run(mainRepo, "{}", log);
		assert.notStrictEqual(code, 0, "an empty payload still fail-closes");
		assert.include(
			readFileSync(log, "utf8"),
			"entry",
			"the entry trace must precede the fail-closed exit, or a hook that dies early is invisible",
		);
	});

	// The trace's non-fatality is the whole reason it is safe to add: `git worktree add` execs
	// hooks with a stripped PATH (#787–#789) against a `.git/hooks` shared by every lane, so a
	// trace that hard-failed would abort worktree creation host-wide. An unwritable log must
	// degrade to "no trace", never to a failed spawn.
	it("an unwritable trace log never changes the exit status — degrades to no trace (#787–#789)", () => {
		const name = "agent-notrace01";
		const expected = join(mainRepo, ".claude", "worktrees", name);
		const stdout = execFileSync("bash", [SCRIPT], {
			cwd: mainRepo,
			input: goldenPayloadFor(mainRepo, name),
			encoding: "utf8",
			env: {
				...process.env,
				// a path under a directory that does not exist — every write to it fails
				KAMPUS_WORKTREE_HOOK_LOG: join(mainRepo, "no", "such", "dir", "trace.log"),
			},
		});
		assert.strictEqual(stdout.trim(), expected, "provisioning must succeed with no trace at all");
		assert.isTrue(existsSync(expected));
	});

	// PATH-resilience, forced the same way the jq-less test forces its branch: with no PATH at
	// all the timestamp helper is unreachable, and the line must still land (an `unknown`
	// timestamp is a degraded field, not a lost proof of invocation).
	it("still traces when `date` is unreachable — the timestamp degrades, the proof does not", () => {
		// A PATH carrying ONLY bash — no `date`, the single external command the trace touches.
		// This is the stripped-PATH exec env of #787–#789, reproduced deterministically.
		const bindir = mkdtempSync(join(tmpdir(), "wtc-nodate-bin-"));
		const bash = execFileSync("bash", ["-lc", "command -v bash"], {encoding: "utf8"}).trim();
		symlinkSync(bash, join(bindir, "bash"));
		// Private log — the shared one already carries `unknown pid=` from the jq-less test above,
		// whose bindir has no `date` either, so asserting there would pass with the degradation
		// removed entirely.
		const log = freshTraceLog();
		try {
			execFileSync(bash, [SCRIPT], {
				cwd: mainRepo,
				input: "{}",
				encoding: "utf8",
				env: {PATH: bindir, HOME: mainRepo, KAMPUS_WORKTREE_HOOK_LOG: log},
			});
		} catch {
			/* expected: an unparseable payload fail-closes — the trace is what's under test */
		} finally {
			rmSync(bindir, {recursive: true, force: true});
		}
		// Existence first: with the degradation removed the trace writes nothing at all, and a bare
		// readFileSync would report that as ENOENT rather than as the property that broke.
		assert.isTrue(existsSync(log), "a date-less run must still produce a trace file");
		assert.include(readFileSync(log, "utf8"), "unknown pid=", "the line lands date-less");
	});

	// Guard the anti-fabrication invariant directly: the raw fixture bytes fed to the handler
	// must be the committed file's, so no future edit can quietly inline a fabricated payload.
	it("loads the payload from the committed fixture file, not an inline literal", () => {
		const raw = readGoldenFixture(import.meta.url, GOLDEN);
		assert.include(raw, '"hook_event_name": "WorktreeCreate"');
		assert.notInclude(
			raw,
			"worktree_path",
			"the committed fixture must not carry the fabricated field",
		);
	});
});
