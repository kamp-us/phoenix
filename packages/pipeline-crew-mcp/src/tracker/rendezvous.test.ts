/**
 * The canonical rendezvous (ADR 0197), proved against REAL git repos rather than a stubbed
 * `rev-parse`: the whole decision rests on git's actual relative-vs-absolute `--git-common-dir`
 * behavior across a main checkout, a nested subdirectory, and a linked worktree, so a fake would
 * assert the belief instead of the platform.
 *
 * The convergence cases are the point. `repo` vs `repo/apps/web` is the literal split-bug scenario
 * (`--git-common-dir` prints `../../.git` from the nested dir), and the linked worktree is the one
 * that broke every prior candidate key — `--show-toplevel` and `--absolute-git-dir` both differ
 * there, which is why ADR 0197 bans them.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	canonicalizeGitCommonDir,
	RendezvousResolutionError,
	rendezvousSocketPathFor,
	resolveRendezvous,
} from "./rendezvous.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", [...args], {cwd, encoding: "utf8"}).trim();

/** A throwaway git repo with one commit — enough for `git worktree add` to have a base to branch from. */
const makeRepo = (label: string): string => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), `rendezvous-${label}-`)));
	execFileSync("git", ["init", "-q", "-b", "main", root]);
	git(root, "config", "user.email", "test@example.invalid");
	git(root, "config", "user.name", "Rendezvous Test");
	git(root, "commit", "-q", "--allow-empty", "-m", "base");
	return root;
};

describe("canonicalizeGitCommonDir — the relative-to-cwd trap (ADR 0197)", () => {
	it("resolves the bare `.git` reading against the main checkout it was read from", () => {
		assert.strictEqual(canonicalizeGitCommonDir(".git", "/repo"), "/repo/.git");
	});
	it("resolves a nested subdir's `../../.git` reading back to the SAME key", () => {
		assert.strictEqual(canonicalizeGitCommonDir("../../.git", "/repo/apps/web"), "/repo/.git");
	});
	it("passes a worktree's already-absolute reading through unchanged", () => {
		assert.strictEqual(canonicalizeGitCommonDir("/repo/.git", "/repo/.wt/lane-a"), "/repo/.git");
	});
});

describe("resolveRendezvous — one repo, one rendezvous", () => {
	it.effect("converges from the repo root, a nested subdir, and a linked worktree", () =>
		Effect.gen(function* () {
			const root = makeRepo("converge");
			const nested = join(root, "apps", "web");
			mkdirSync(nested, {recursive: true});
			const worktree = join(root, ".wt", "lane-a");
			git(root, "worktree", "add", "-q", "-b", "lane-a", worktree);

			// The reading really is relative-to-cwd and really does differ — the trap this module handles.
			assert.strictEqual(git(root, "rev-parse", "--git-common-dir"), ".git");
			assert.strictEqual(git(nested, "rev-parse", "--git-common-dir"), "../../.git");

			// …and `--absolute-git-dir` really does split in a worktree, which is why it is banned.
			assert.notStrictEqual(
				git(worktree, "rev-parse", "--absolute-git-dir"),
				git(root, "rev-parse", "--absolute-git-dir"),
			);

			const fromRoot = yield* resolveRendezvous(root);
			const fromNested = yield* resolveRendezvous(nested);
			const fromWorktree = yield* resolveRendezvous(worktree);

			assert.strictEqual(fromRoot.repoKey, realpathSync(join(root, ".git")));
			assert.strictEqual(fromNested.repoKey, fromRoot.repoKey);
			assert.strictEqual(fromWorktree.repoKey, fromRoot.repoKey);
			assert.strictEqual(fromNested.socketPath, fromRoot.socketPath);
			assert.strictEqual(fromWorktree.socketPath, fromRoot.socketPath);
			assert.match(fromRoot.socketPath, /kampus-crew-[0-9a-f]{16}\.sock$/);

			rmSync(root, {recursive: true, force: true});
		}),
	);

	it.effect("keeps two different repos on different rendezvous", () =>
		Effect.gen(function* () {
			const a = makeRepo("iso-a");
			const b = makeRepo("iso-b");

			const rendezvousA = yield* resolveRendezvous(a);
			const rendezvousB = yield* resolveRendezvous(b);

			assert.notStrictEqual(rendezvousA.repoKey, rendezvousB.repoKey);
			assert.notStrictEqual(rendezvousA.socketPath, rendezvousB.socketPath);

			rmSync(a, {recursive: true, force: true});
			rmSync(b, {recursive: true, force: true});
		}),
	);

	it.effect("errors on a non-repo dir rather than falling back to a cwd-derived path", () =>
		Effect.gen(function* () {
			// `/` is outside any work tree on a test machine, so discovery has nothing to find.
			const failure = yield* Effect.flip(resolveRendezvous("/"));
			assert.instanceOf(failure, RendezvousResolutionError);
			assert.strictEqual(failure.startDir, "/");
		}),
	);
});

describe("rendezvousSocketPathFor — the key is the only input", () => {
	it("honors XDG_RUNTIME_DIR when set", () => {
		const previous = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = "/run/user/501";
		const socketPath = rendezvousSocketPathFor("/repo/.git");
		if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previous;
		assert.match(socketPath, /^\/run\/user\/501\/kampus-crew-[0-9a-f]{16}\.sock$/);
	});
});
