/**
 * `runSweep` over a fake `.decisions` dir — the filesystem-seam test (#855). The ranking itself
 * is covered in `adr-sweep.unit.test.ts`; this crosses the IO gate over a real temp dir and
 * asserts the exit contract from observable outcomes, never by spawning the bin: exit 0 only on
 * `no-overlap`; `shortlist`, `indeterminate`, a missing subject, malformed front-matter, and an
 * empty corpus all `CheckFailed`.
 */
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit, type FileSystem, type Path} from "effect";
import {DEFAULT_LIMIT} from "./adr-sweep.ts";
import {CheckFailed, runSweep} from "./gate.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "adr-sweep-gate-"));
});
afterEach(() => {
	rmSync(dir, {recursive: true, force: true});
});

const write = (
	id: string,
	{
		title,
		status = "accepted",
		tags = "pipeline",
		decision,
	}: {title: string; status?: string; tags?: string; decision: string},
) =>
	writeFileSync(
		join(dir, `${id}-fixture.md`),
		`---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ndate: 2026-07-25\ntags: [${tags}]\n---\n\n# ${id} — ${title}\n\n**What this decides:** ${decision}\n\n## Decision\n${decision}\n`,
		"utf8",
	);

/** Unrelated ADRs so rarity has a corpus (`MIN_CORPUS_FOR_RARITY`) and no term reads as common. */
const writeFiller = (n = 14) => {
	for (let i = 0; i < n; i++) {
		write(String(700 + i).padStart(4, "0"), {
			title: `Filler ${i} governs rendering and hydration`,
			tags: "frontend",
			decision: `Rendering uses cached snapshot ${i}; hydration never blocks paint.`,
		});
	}
};

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	Effect.runPromiseExit(Effect.provide(effect, NodeServices.layer));

const failure = (exit: Exit.Exit<unknown, unknown>): CheckFailed | null => {
	if (!Exit.isFailure(exit)) return null;
	const squashed = Cause.squash(exit.cause);
	return squashed instanceof CheckFailed ? squashed : null;
};

const sweepIn = (newRef: string, json = false) =>
	run(runSweep({dir, newRef, limit: DEFAULT_LIMIT, json}));

describe("runSweep — the exit contract over a fake .decisions dir", () => {
	it("SUCCEEDS (exit 0) when the swept set shares no decision vocabulary", async () => {
		writeFiller();
		write("0300", {
			title: "Turnstile quota governs kefil vouches",
			tags: "moderation",
			decision: "A kefil vouch consumes a turnstile quota unit.",
		});
		write("0301", {
			title: "Rendering uses a cached snapshot",
			decision: "Hydration never blocks paint.",
		});
		expect(Exit.isSuccess(await sweepIn("0300"))).toBe(true);
	});

	it("FAILS with the shortlist when an uncited live-accepted ADR is adjacent", async () => {
		writeFiller();
		write("0300", {
			title: "Milestones encode strategic sequencing",
			decision: "A milestone is an optional dimension; unmilestoned means parked.",
		});
		write("0301", {
			title: "Every open issue is milestone-homed or killed",
			decision: "Every open issue takes a milestone or is killed; unmilestoned is not a home.",
		});
		const report = failure(await sweepIn("0301"));
		expect(report?.reason).toContain("SHORTLIST");
		expect(report?.reason).toContain("0300");
	});

	it("FAILS `indeterminate` — distinct from a clean sweep — when there is nothing to key on", async () => {
		writeFileSync(
			join(dir, "0300-empty.md"),
			"---\nid: 0300\ntitle: a\nstatus: accepted\ndate: 2026-07-25\ntags: []\n---\n\nbody\n",
			"utf8",
		);
		write("0301", {title: "Some other rule", decision: "Rendering caches the snapshot."});
		expect(failure(await sweepIn("0300"))?.reason).toContain("INDETERMINATE");
	});

	it("FAILS CLOSED on an id with no matching ADR file", async () => {
		write("0300", {title: "A rule", decision: "Something binds."});
		expect(failure(await sweepIn("0999"))?.reason).toContain("no ADR file for id");
	});

	it("FAILS CLOSED on malformed front-matter anywhere in the corpus", async () => {
		write("0300", {title: "A rule", decision: "Something binds."});
		writeFileSync(join(dir, "0301-broken.md"), "no front-matter here\n", "utf8");
		expect(failure(await sweepIn("0300"))?.reason).toContain("missing front-matter field");
	});

	it("FAILS CLOSED on zero scope — a corpus whose only other ADR is superseded", async () => {
		write("0300", {title: "A rule about milestones", decision: "Milestones are optional."});
		write("0301", {
			title: "An old rule",
			status: "superseded by [0300](0300-fixture.md)",
			decision: "Milestones are mandatory.",
		});
		expect(failure(await sweepIn("0300"))?.reason).toContain("zero live-accepted");
	});

	it("accepts a path to an ADR not yet in the corpus dir (the mid-PR shape)", async () => {
		writeFiller();
		const subject = join(dir, "..", `adr-sweep-subject-${process.pid}.md`);
		writeFileSync(
			subject,
			"---\nid: 0400\ntitle: Turnstile quota governs kefil vouches\nstatus: accepted\ndate: 2026-07-25\ntags: [moderation]\n---\n\n**What this decides:** A kefil vouch consumes a turnstile quota unit.\n\n## Decision\nEvery kefil vouch decrements the turnstile quota.\n",
			"utf8",
		);
		const exit = await run(runSweep({dir, newRef: subject, limit: DEFAULT_LIMIT, json: false}));
		rmSync(subject, {force: true});
		// The subject shares no vocabulary with the corpus, so a resolvable path yields a clean run —
		// which is what proves the path branch resolved rather than silently swept nothing.
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("emits machine-readable JSON under --json, carrying the caveat with the outcome", async () => {
		writeFiller();
		write("0300", {
			title: "Milestones encode strategic sequencing",
			decision: "A milestone is an optional dimension; unmilestoned means parked.",
		});
		write("0301", {
			title: "Every open issue is milestone-homed or killed",
			decision: "Every open issue takes a milestone or is killed; unmilestoned is not a home.",
		});
		const parsed = JSON.parse(failure(await sweepIn("0301", true))?.reason ?? "{}");
		expect(parsed.outcome._tag).toBe("shortlist");
		expect(parsed.caveat).toContain("does NOT detect semantic contradiction");
	});
});
