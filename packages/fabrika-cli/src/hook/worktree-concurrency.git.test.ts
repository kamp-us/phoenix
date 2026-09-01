/**
 * `hook worktree-create`'s **whole** provisioning sequence, `git worktree add` included, against
 * real git in a throwaway clone (#7331).
 *
 * `worktree-base.git.test.ts` beside this file judges the base resolution and deliberately keeps the
 * add out of its loop, because the add carries faults #6081 did not claim to fix. This file is those
 * faults: the two administrative-state arms {@link concurrencyArm} names, and the recovery that
 * clears them.
 *
 * **What this file exercises is the derivation, not the Effect wrapper** — the same split
 * `worktree-base.git.test.ts` documents. The loop in {@link provision} is the shape
 * `withConcurrencyRecovery` folds over a spawner in `worktree-create-verb.ts`, and its decisions —
 * which diagnostics are recoverable, whether to prune, how many attempts and how long to wait — are
 * imported from the module under test rather than restated, so a change to any of them moves this
 * file too.
 *
 * **The demonstration is injected, not raced for, and that is the point.** The report behind #7331
 * read the arm out of a timing race, and a test that waits for one is a test that hangs on the
 * machine where it never fires. The state is reproduced directly instead — the exact
 * administrative directory a failed `git worktree add` leaves — so the fault fires on every git
 * measured without waiting for anything. The timing race is still driven, at a declared bound, and
 * asserts nothing when it does not open.
 *
 * **One thing about that planted state is version-dependent, and it is asserted as a choice between
 * the two behaviours measured rather than as the one this machine has.** Whether a *bare* re-run
 * clears the leftover entry is git's own business: on git 2.40.1 it never does, and on git 2.55.0
 * the second identical fetch succeeds. Pinning either reds the other machine, and asserting nothing
 * would let an unmeasured third behaviour through, so the test below admits exactly those two and
 * names `gitVersion()` in its failure message. What holds on both — and is what the recovery rests
 * on — is that pruning then re-attempting clears it.
 *
 * **Measured in this file** (`gitVersion()` is printed into every skip and into the version-split
 * assertion); the version each measurement holds on is named with it:
 *  - a leftover administrative directory fails the next fetch on both gits measured; a *bare*
 *    re-run keeps failing on git 2.40.1 and succeeds on git 2.55.0;
 *  - on git 2.40.1, macOS: a live add holds `worktrees/<name>/locked` = `initializing` across its
 *    creation window, so `git worktree prune` cannot deregister it;
 *  - on git 2.40.1, macOS: the placeholder HEAD closes before `post-checkout`, so the live window
 *    never spans the install.
 *
 * **What the production trace can retain (acceptance criterion 7).** Nothing here confirms the six
 * `fail: git fetch origin main` entries the #7331 report read out of the hook trace, and what this
 * change can promise is bounded by the `WorktreeCreate` contract — quoted verbatim in
 * `claude-plugins/fabrika/docs/hook-surface.md` under *`WorktreeCreate` — a provider hook, left
 * undeclared*. That entry gives stdout one meaning, the worktree path, and says of the rest only
 * `Exit code 0 - worktree created successfully` / `Other exit codes - worktree creation failed`. It
 * makes no statement about a hook's stderr, unlike the `WorktreeRemove` entry beside it, which does.
 * So nothing in the contract retains a *recovered* arm's diagnostic — the case this change creates —
 * and that is left unclaimed rather than inferred from the `PreToolUse` exit-code table, which the
 * same doc warns carries different meanings per event.
 *
 * What is retained is the *exhausted* arm, and on fabrika's own surface rather than the harness's:
 * the refusal keeps git's own line plus the cause it lost to, and the same doc reproduces the
 * harness surfacing a failed `WorktreeCreate` hook's output live (`Error creating worktree:
 * WorktreeCreate hook failed: …`). So a future `BASE_FETCH_FAILED` that really is this fault says so
 * in its own text. The six old entries stay what the report called them, an inference from shape.
 * This PR reclassifies none of them, and the shape it measured — every failing fetch naming one
 * worktree, the first spawn's, whose own add had already failed — is consistent with that inference
 * without proving it.
 */
import {execFile} from "node:child_process";
import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {promisify} from "node:util";
import {afterAll, describe, expect, it} from "vitest";
import {
	GIT_ENV,
	gitSync,
	gitVersion,
	openClone,
	removeClones,
} from "./throwaway-clone.test-support.ts";
import {
	baseRefFor,
	type ConcurrencyArm,
	concurrencyArm,
	dropBaseRefArgs,
	fetchBaseArgs,
	pruneWorktreesArgs,
	RECOVERY_ATTEMPTS,
	recoveryBackoffMs,
	resolveBaseArgs,
} from "./worktree-create.ts";

const run = promisify(execFile);

const SPAWNS = 16;
const ROUNDS = 12;

/**
 * Sibling spawns are started offset from each other, not in lockstep.
 *
 * A fan released at once runs every fetch, then every add, so the fetches are all finished before
 * the first add opens its window. Offsetting the starts is what a real fan does anyway: the harness
 * spawns agents as it reaches them, so one lane's fetch lands inside another's add. Fixed, not
 * random, so a red is reproducible.
 */
const STAGGER_MS = 60;

const NULL_OID = "0".repeat(40);

const after = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));

const stderrOf = (cause: unknown): string =>
	String((cause as {stderr?: string}).stderr ?? (cause as Error).message).trim();

/**
 * The administrative directory a `git worktree add` leaves behind when it dies after registering the
 * worktree and before checking it out — the dead-sibling source, planted rather than raced for.
 *
 * `HEAD` at the null oid is what git itself writes there first; the worktree directory is
 * deliberately never created, which is exactly the state prune exists to drop.
 */
const plantDeadSibling = (clone: string, name: string): void => {
	const admin = join(clone, ".git", "worktrees", name);
	mkdirSync(admin, {recursive: true});
	writeFileSync(join(admin, "HEAD"), `${NULL_OID}\n`);
	writeFileSync(join(admin, "commondir"), "../..\n");
	writeFileSync(join(admin, "gitdir"), `${join(clone, "..", "gone", name)}/.git\n`);
};

interface Spawn {
	readonly base: string;
	readonly created: boolean;
	/** Every failure this spawn saw, in order — empty when nothing went wrong. */
	readonly failures: ReadonlyArray<string>;
}

/**
 * One spawn's full provisioning sequence: fetch a per-spawn base ref, resolve it, drop it, then add
 * the worktree — the four commands the verb runs, in the verb's order.
 *
 * `attempts` is what makes this the pre-fix or the fixed sequence. At 1 it is exactly what shipped
 * before #7331 and every arm is terminal; at {@link RECOVERY_ATTEMPTS} it is the recovery the verb
 * now performs, prune included, and nothing else about the sequence differs.
 */
const provision = async (
	clone: string,
	scratch: string,
	name: string,
	attempts: number,
): Promise<Spawn> => {
	const ref = baseRefFor(name, "0123456789ab");
	const failures: string[] = [];
	const git = (args: ReadonlyArray<string>) => run("git", [...args], {cwd: clone, env: GIT_ENV});

	const recovered = async (args: ReadonlyArray<string>): Promise<string | null> => {
		for (let attempt = 1; ; attempt++) {
			try {
				return (await git(args)).stdout.trim();
			} catch (cause) {
				const stderr = stderrOf(cause);
				failures.push(stderr.split("\n").join(" | "));
				if (concurrencyArm(stderr) === null || attempt >= attempts) return null;
				await git(pruneWorktreesArgs).catch(() => undefined);
				await after(recoveryBackoffMs(attempt));
			}
		}
	};

	const lost = {base: "", created: false, failures};
	if ((await recovered(fetchBaseArgs("main", ref))) === null) return lost;
	// Plain, not `recovered`: the verb does not wrap the resolve either, because `rev-parse` reads
	// one ref by name and walks no worktree entry. A recovery only the model has would hide a lost
	// spawn production would take.
	const base = await git(resolveBaseArgs(ref)).then(
		(done) => done.stdout.trim(),
		(cause) => {
			failures.push(stderrOf(cause).split("\n").join(" | "));
			return "";
		},
	);
	await git(dropBaseRefArgs(ref)).catch(() => undefined);
	if (base === "") return lost;

	const added = await recovered(["worktree", "add", "--detach", join(scratch, name), base]);
	return {base, created: added !== null, failures};
};

const fan = async (
	clone: string,
	scratch: string,
	attempts: number,
	label: string,
): Promise<ReadonlyArray<Spawn>> => {
	const spawns: Spawn[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		spawns.push(
			...(await Promise.all(
				Array.from({length: SPAWNS}, (_, i) =>
					after(i * STAGGER_MS).then(() =>
						provision(clone, scratch, `${label}-${round}-${i}`, attempts),
					),
				),
			)),
		);
	}
	return spawns;
};

const armsIn = (spawns: ReadonlyArray<Spawn>): ReadonlySet<ConcurrencyArm> => {
	const arms = new Set<ConcurrencyArm>();
	for (const spawn of spawns) {
		for (const failure of spawn.failures) {
			const arm = concurrencyArm(failure);
			if (arm !== null) arms.add(arm);
		}
	}
	return arms;
};

afterAll(removeClones);

describe("a dead sibling's leftover administrative directory", () => {
	it("fails the pre-fix sequence — the fault fires with no race to wait for", async () => {
		const {clone, scratch} = openClone();
		plantDeadSibling(clone, "wt-0-0");

		const spawn = await provision(clone, scratch, "pre", 1);

		expect(spawn.created).toBe(false);
		expect(armsIn([spawn])).toEqual(new Set(["PlaceholderHead"]));
	}, 120_000);

	/**
	 * Whether a *bare* re-run clears the leftover is version-dependent, so this admits both measured
	 * behaviours and names the git it saw. Pinning either reds the other machine — git 2.40.1 keeps
	 * failing, git 2.55.0 heals — and asserting nothing would let an unmeasured third through.
	 */
	it("keeps failing a bare re-run, or heals it, according to this machine's git", async () => {
		const {clone, scratch} = openClone();
		plantDeadSibling(clone, "wt-0-0");
		expect((await provision(clone, scratch, "pre", 1)).created).toBe(false);

		const again = await provision(clone, scratch, "pre-again", 1);
		const outcome = again.created
			? "healed"
			: armsIn([again]).has("PlaceholderHead")
				? "still-failing"
				: `failed on something else: ${again.failures.join(" / ")}`;

		expect(
			["still-failing", "healed"],
			`a bare re-run on ${gitVersion()} — neither behaviour this fault has been measured to have`,
		).toContain(outcome);
	}, 120_000);

	it("is cleared by the recovery, so the same spawn provisions on a later attempt", async () => {
		const {clone, scratch, tip} = openClone();
		plantDeadSibling(clone, "wt-0-0");

		const spawn = await provision(clone, scratch, "fixed", RECOVERY_ATTEMPTS);

		expect(spawn.base).toBe(tip);
		expect(spawn.created).toBe(true);
		// It recovered rather than never hitting the fault — the arm is in its failure trail.
		expect(armsIn([spawn])).toEqual(new Set(["PlaceholderHead"]));
	}, 120_000);

	it("is dropped by the prune, while a worktree whose directory exists is left registered", async () => {
		const {clone, scratch, tip} = openClone();
		mkdirSync(scratch, {recursive: true});
		gitSync(clone, "worktree", "add", "--quiet", "--detach", join(scratch, "live"), tip);
		plantDeadSibling(clone, "wt-0-0");

		gitSync(clone, ...pruneWorktreesArgs);

		const listed = gitSync(clone, "worktree", "list", "--porcelain");
		expect(listed).toContain(join(scratch, "live"));
		expect(listed).not.toContain("wt-0-0");
	}, 120_000);
});

describe("provisioning a worktree under parallel spawns", () => {
	it("loses none of them, with every spawn on the freshly fetched tip", async () => {
		const {clone, scratch, tip} = openClone();
		const spawns = await fan(clone, scratch, RECOVERY_ATTEMPTS, "fan");

		expect(spawns).toHaveLength(SPAWNS * ROUNDS);
		// Asserted as sets so a failure prints the losing spawn's own diagnostics, not `191 !== 192`.
		expect(new Set(spawns.map((spawn) => spawn.base))).toEqual(new Set([tip]));
		expect(new Set(spawns.map((spawn) => spawn.created))).toEqual(new Set([true]));
	}, 300_000);

	/**
	 * The live-sibling source, which unlike the planted one has to be raced for. Bounded and
	 * declared: on a machine where the window does not open in this budget the test asserts nothing
	 * rather than spinning until it does.
	 */
	it("recovers from the live window too, when this machine's timing opens one", async ({skip}) => {
		const {clone, scratch} = openClone();
		const spawns = await fan(clone, scratch, RECOVERY_ATTEMPTS, "live");

		if (armsIn(spawns).size === 0) {
			skip(
				`no live concurrency window opened in ${SPAWNS * ROUNDS} spawns on ${gitVersion()} — the window is timing-dependent and this budget is bounded, so nothing is asserted rather than spun for`,
			);
			return;
		}
		expect(spawns.filter((spawn) => !spawn.created)).toEqual([]);
	}, 300_000);
});

describe("classifying a git diagnostic as one of the two named arms", () => {
	it.each([
		[
			"PlaceholderHead",
			"fatal: bad object worktrees/wt-0-0/HEAD\nerror: origin did not send all necessary objects",
		],
		[
			"IncompleteAdminDir",
			"fatal: failed to read .git/worktrees/wt-3-9/commondir: Undefined error: 0",
		],
	])("recognises %s from git's own text", (arm, diagnostic) => {
		expect(concurrencyArm(diagnostic)).toBe(arm);
	});

	/**
	 * The fail-closed half. Recovering from a genuine failure is worse than losing the spawn: it
	 * spends the prune and the backoff and then refuses with the same code anyway, so an
	 * unrecognised diagnostic must classify as nothing.
	 */
	it.each([
		["a credential miss", "fatal: Could not read from remote repository."],
		["a path already in use", "fatal: '/repo/.claude/worktrees/a' already exists"],
		["an unresolvable base", `fatal: invalid reference: ${NULL_OID}`],
		["this spawn's own missing tree", "fatal: could not read worktrees/a/gitdir"],
		["nothing at all", ""],
	])("classifies %s as no arm, so it refuses on the first attempt", (_label, diagnostic) => {
		expect(concurrencyArm(diagnostic)).toBeNull();
	});
});

describe("the recovery's bounds", () => {
	it("doubles the wait and then caps it, so one command waits at most 3s", () => {
		const waits = Array.from({length: RECOVERY_ATTEMPTS - 1}, (_, i) => recoveryBackoffMs(i + 1));
		expect(waits).toEqual([200, 400, 800, 1600]);
		// Per wrapped command, and the verb wraps two — so a spawn losing at both waits up to 6s of
		// its 600s budget, not 3s.
		expect(waits.reduce((a, b) => a + b, 0)).toBe(3_000);
	});
});
