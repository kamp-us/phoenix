/**
 * `cron`, driven with `testProgram` — no kernel, no desk, no timer.
 *
 * This is the suite that came with the program out of `kamp-us/phoenix`, rewritten to import
 * through the three published doors and nothing else. Three cases from the original are not here,
 * and each one is a name the door does not carry rather than a case that stopped mattering:
 *
 *  - the `shapeOf`/`fillArgs` fit is asserted through `cron({…, job: session()})` instead, which is
 *    the same refusal from outside — `defineProgram` runs the fill and throws on a job that does
 *    not fit `jobShape`, so a passing call *is* the fit;
 *  - the spawn-handler case that provided `SpawnedProcesses` and `ProcessSelf` by hand is gone:
 *    both are kernel services, neither is public, and nothing outside the kernel can stand one up;
 *  - `cron-run.unit.test.ts`, which boots a real kernel through `launch`/`Registry`/`Processes` to
 *    prove `:cron run` reaches the planned cron, stays in phoenix for the same reason.
 *
 * The cases under "cron's job shape against a real session row" are the ones about something other
 * than cron: they pin the seam between an authored shape and a live session row (`cron.ts`'s
 * header). They used to pin the *failure* — that no live row could fit the shape, which is why a
 * `sessionAsJob` wrapper existed. #8887 and #8959 closed that, so they now pin the fit, and the day
 * a row stops publishing its payload schemas the wrapper's absence shows up as a failing test here
 * rather than as a config that will not boot.
 */

import {
  PromptPayloadSchema,
  type TurnResult,
  TurnResultSchema,
} from "@kampus/tuval/ai-agent/ports";
import {
  type AnyProgram,
  emit,
  type PortSchema,
  ProcessId,
  Program,
  type ShapeSource,
  STATUS_PORT,
  send,
  spawn,
  stop,
  TITLE_PORT,
  testProgram,
} from "@kampus/tuval/authoring";
import { ClientId, claudeSession, WorkspaceId } from "@kampus/tuval/sessions";
import { describe, expect, it } from "vitest";
import config, { eveningSummary, standup } from "../.tuval/tuval.config.ts";
import { BRIEF_PORT, cron, cronProgram, jobShape } from "./cron.ts";
import { CRON_WINDOW_REF } from "./renderer-ref.ts";
import { type CronState, HISTORY, INTERRUPTED } from "./state.ts";

/** Seven in the morning, so a status line reads the way the epic's example spells one. */
const SEVEN = new Date(2026, 8, 10, 7, 0, 12).getTime();

const options = {
  everyMs: 60_000,
  prompt: "what changed?",
  now: () => SEVEN,
} as const;

/** The job process a case names. `ProcessId` is a value on the door (#9250), so the brand is made. */
const child = ProcessId.make("proc-job");

/** The shaped arg cron spawns through — the `Spawnable` half of the declared shape. */
const jobRef = cronProgram(options).args.job;

/** A finished turn, as the job's `result` out-port carries one. */
const turn = (text: string, ok: boolean): TurnResult => ({
  text,
  items: [],
  ok,
});

const scope = {
  workspace: WorkspaceId.make("tuval/test"),
  client: ClientId.make("tuval/test"),
};

/** A real session row, built the way the config builds one. */
const session = (): AnyProgram =>
  claudeSession({
    cwd: "/tmp/cron-test",
    scope: { ...scope, client: ClientId.make("tuval-desk") },
  });

const portsOf = (row: AnyProgram): Readonly<Record<string, PortSchema>> =>
  row.ports;

describe("cron says what it is before anything has happened", () => {
  it("publishes its cadence and an idle status on a fresh process", () => {
    const run = testProgram(cronProgram(options));
    expect(run.state).toEqual({
      id: "cron",
      cadence: "every 60s",
      child: null,
      startedAt: null,
      runs: [],
      ticks: 0,
    });
    expect(run.effects).toEqual([
      emit(TITLE_PORT, "cron · every 60s"),
      emit(STATUS_PORT, "idle"),
    ]);
  });

  it("carries its id and its cadence on state, so a window can say what it is", () => {
    // Env rather than state: no cell moves either, and a window is handed one thing — this
    // process's public state — so a cron with neither could not name itself in its own window.
    const named = testProgram(
      cronProgram({
        ...options,
        id: "morning-brief",
        everyMs: undefined,
        schedule: "0 7 * * *",
      }),
    );
    expect(named.state.id).toBe("morning-brief");
    expect(named.state.cadence).toBe("daily 07:00");
  });

  it("says `on demand` when it takes no timer, and declares no Sub for one", () => {
    const idle = cronProgram({ ...options, everyMs: null });
    expect(idle.subs).toEqual([]);
    expect(testProgram(idle).effects).toContainEqual(
      emit(TITLE_PORT, "cron · on demand"),
    );
    expect(cronProgram(options).subs).toHaveLength(1);
  });
});

describe("cron, woken", () => {
  it("asks for a spawn of the job on a tick", () => {
    const run = testProgram(cronProgram(options)).event({ type: "tick" });
    expect(run.state.ticks).toBe(1);
    expect(run.effects).toContainEqual(
      spawn(jobRef, { on: { result: "result" } }),
    );
  });

  it("sends the configured prompt as a well-formed PromptPayload once the job is up", () => {
    const run = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" });
    expect(run.state.child).toBe(child);
    const sent = run.effects.find((effect) => effect.type === "send");
    expect(sent).toEqual({
      type: "send",
      to: { process: child, port: "prompt" },
      payload: {
        text: "what changed?",
        key: `cron-${SEVEN}`,
        timestamp: SEVEN,
      },
    });
    // The payload the job's own port admits, not just one this program happened to build.
    const ports = portsOf(session());
    expect(
      ports.prompt?.accepts((sent as { readonly payload: unknown }).payload),
    ).toBe(true);
  });

  it("reports the run as running until something ends it", () => {
    const run = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" });
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "running since 07:00:12"),
    );
  });

  it("drops a tick that lands while a job is still running", () => {
    const run = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" })
      .event({ type: "tick" });
    expect(run.state.ticks).toBe(2);
    expect(run.effects.filter((effect) => effect.type === "spawn")).toEqual([]);
  });
});

describe("cron, reporting", () => {
  /** A whole run: the answer ends it, so the history and the tile are settled at `result`. */
  const finished = (ok: boolean) =>
    testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" })
      .event({ type: "result", payload: turn("five lines\nand the rest", ok) });

  it("keeps the first line of an ok turn and says so", () => {
    const run = finished(true);
    expect(run.state.runs[0]).toEqual({
      startedAt: SEVEN,
      ok: true,
      summary: "five lines",
    });
    expect(run.state.child).toBeNull();
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "last run 07:00 · ok"),
    );
  });

  it("says `failed` for a turn that ended badly, and still clears the child", () => {
    const run = finished(false);
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "last run 07:00 · failed"),
    );
    expect(run.state.child).toBeNull();
  });

  /**
   * The port this package grew so that a finished brief has somewhere to go. Until it existed the
   * job's answer reached the `result` *cell* and stopped there, folded into a one-line `summary`:
   * `morningBrief.ports.result` was `undefined`, cron's only out-ports were the kernel's own two,
   * and a notifier or a `graph` route had nothing to be wired to.
   */
  it("announces the whole turn on `brief`, not the line the tile keeps", () => {
    const run = finished(true);
    expect(run.effects).toContainEqual(
      emit(BRIEF_PORT, turn("five lines\nand the rest", true)),
    );
    // The turn itself, so nothing downstream has to reconstruct what the tile threw away.
    expect(run.state.runs[0]?.summary).toBe("five lines");
  });

  it("announces a failed turn too, because `ok` is the consumer's to read", () => {
    expect(finished(false).effects).toContainEqual(
      emit(BRIEF_PORT, turn("five lines\nand the rest", false)),
    );
  });

  it("emits the brief before it reaps the job that wrote it", () => {
    const asked = finished(true).effects.map((effect) => effect.type);
    expect(asked.indexOf("emit")).toBeLessThan(asked.indexOf("stop"));
  });

  it("says nothing on `brief` for a run with no turn behind it", () => {
    // A job that ended before answering is a real failed run and the tile says so — but there is no
    // `TurnResult`, and a fabricated one would be cron putting words in a job's mouth.
    const died = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" })
      .event({ type: "stopped", process: child });
    expect(
      died.effects.filter(
        (effect) => effect.type === "emit" && effect.port === BRIEF_PORT,
      ),
    ).toEqual([]);
    expect(died.state.runs).toHaveLength(1);
  });

  it("stops the job it started once the answer lands, so the session does not outlive its turn", () => {
    const run = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" })
      .event({ type: "result", payload: turn("done", true) });
    expect(run.effects).toContainEqual(stop(child));
    expect(run.state.child).toBeNull();
    expect(run.state.startedAt).toBeNull();
  });

  it("spawns again on the next tick, because the answer already freed the child", () => {
    const run = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" })
      .event({ type: "result", payload: turn("done", true) })
      .event({ type: "stopped", process: child })
      .event({ type: "tick" });
    expect(run.state.ticks).toBe(2);
    expect(run.effects).toContainEqual(
      spawn(jobRef, { on: { result: "result" } }),
    );
  });

  it("takes the `stopped` for the child it already ended as nothing, so one turn is one run", () => {
    const run = finished(true).event({ type: "stopped", process: child });
    expect(run.state.runs).toHaveLength(1);
    expect(run.effects).toEqual([]);
  });

  // The cell over the event #9227 now delivers. What puts a real child's end on this cell is the
  // finalizer inside the kernel; here the event is fed directly, to pin what the cell does with it.
  it("records a failed run when the job ends before it answers", () => {
    const run = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" })
      .event({ type: "stopped", process: child });
    expect(run.state.runs).toEqual([
      { startedAt: SEVEN, ok: false, summary: "ended without answering" },
    ]);
    expect(run.state.child).toBeNull();
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "last run 07:00 · failed"),
    );
  });

  it("bounds the history at ten runs, newest first", () => {
    let run = testProgram(cronProgram(options));
    for (let index = 0; index < HISTORY + 4; index += 1) {
      run = run
        .event({ type: "tick" })
        .event({ type: "spawned", process: child, program: "cron-job" })
        .event({ type: "result", payload: turn(`run ${index}`, true) })
        .event({ type: "stopped", process: child });
    }
    expect(run.state.runs).toHaveLength(HISTORY);
    expect(run.state.runs[0]?.summary).toBe(`run ${HISTORY + 3}`);
    expect(run.state.runs.at(-1)?.summary).toBe(`run ${4}`);
  });
});

describe("cron, restarted mid-run", () => {
  /** The checkpoint a Ctrl-C mid-run leaves behind: a `child` set, and no answer coming for it. */
  const interrupted = () =>
    testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" });

  /** That checkpoint, brought back: the row's own resume events, applied to it. */
  const restarted = () =>
    cronProgram(options)
      .resume(interrupted().state)
      .reduce((run, event) => run.event(event), interrupted());

  it("asks to reconcile on every restore, holding a child or not", () => {
    // Every boot, because `id` and `cadence` are env and the config — not the checkpoint — is the
    // authority on them. A checkpoint with no child just takes the cheap half of the cell.
    expect(cronProgram(options).resume(interrupted().state)).toEqual([
      { type: "restored" },
    ]);
    expect(
      cronProgram(options).resume(testProgram(cronProgram(options)).state),
    ).toEqual([{ type: "restored" }]);
    // The row the kernel dispatches through carries it, not just the authored record.
    expect(
      cron({ ...options, job: session() as ShapeSource }).resume?.(
        interrupted().state,
      ),
    ).toEqual([{ type: "restored" }]);
  });

  it("records the half-finished run as failed and clears the child, so the tile stops lying", () => {
    const run = restarted();
    expect(run.state.runs).toEqual([
      { startedAt: SEVEN, ok: false, summary: INTERRUPTED },
    ]);
    expect(run.state.child).toBeNull();
    expect(run.state.startedAt).toBeNull();
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "last run 07:00 · failed"),
    );
  });

  it("spawns on the very next tick, which is the drop-every-tick wedge a restart used to cause", () => {
    const run = restarted().event({ type: "tick" });
    expect(run.effects).toContainEqual(
      spawn(jobRef, { on: { result: "result" } }),
    );
  });

  /**
   * A restored child that *is* live takes the same branch, deliberately. Tuval's restore path
   * spawns a checkpointed process with no `on` record and an `unwired` `ProcessPorts`, so a
   * restored session's `result` reaches no cron however long cron waits; and a `stop` of a child
   * the manifest did not bring back fails `ProcessNotFound` out of the resume dispatch, which
   * nothing catches. So cron reaps nothing and asks for nothing it cannot know is safe.
   */
  it("asks for no stop and no send, because it cannot know whether the child came back", () => {
    const asked = restarted().effects.map((effect) => effect.type);
    expect(asked).not.toContain("stop");
    expect(asked).not.toContain("send");
  });

  it("announces no brief for the run the restart cut in half, because there was no turn", () => {
    expect(
      restarted().effects.filter(
        (effect) => effect.type === "emit" && effect.port === BRIEF_PORT,
      ),
    ).toEqual([]);
    // And the late answer from the old child, which *is* a turn, leaves through the port as usual.
    expect(
      restarted().event({ type: "result", payload: turn("late", true) })
        .effects,
    ).toContainEqual(emit(BRIEF_PORT, turn("late", true)));
  });

  it("takes a late answer from the old child as its own run, never as the interrupted one", () => {
    const run = restarted().event({
      type: "result",
      payload: turn("late", true),
    });
    expect(run.state.runs.map((entry) => entry.summary)).toEqual([
      "late",
      INTERRUPTED,
    ]);
    expect(run.effects.filter((effect) => effect.type === "stop")).toEqual([]);
  });

  it("reconciles once: a second restore over the reconciled state records no second run", () => {
    const reconciled: CronState = restarted().state;
    const again = cronProgram(options)
      .resume(reconciled)
      .reduce((run, event) => run.event(event), restarted());
    expect(again.state.runs).toEqual(restarted().state.runs);
    expect(again.state.child).toBeNull();
  });

  it("re-reads `id` and `cadence` off the config, so a checkpoint cannot pin a stale schedule", () => {
    // A checkpoint written before the config moved to a cron expression — and, for an older one
    // still, before either field existed at all. Both come back on the config's terms.
    const stale = { ...interrupted().state, id: "cron", cadence: "every 60s" };
    const moved = cronProgram({
      ...options,
      everyMs: undefined,
      schedule: "0 7 * * *",
    });
    const [back] = moved.update.restored(stale, { type: "restored" });
    expect(back.cadence).toBe("daily 07:00");
    expect(back.id).toBe("cron");
  });
});

describe("cron's `run` command", () => {
  it("sends to its own program's `run` port and asks for nothing else", () => {
    const run = testProgram(cronProgram(options)).call("run", {}, scope);
    // A bare port name, which is what makes the call land on *this* program's live process rather
    // than mint a parentless child of its own.
    expect(run.effects).toEqual([send("run", {})]);
    expect(run.state).toEqual({
      id: "cron",
      cadence: "every 60s",
      child: null,
      startedAt: null,
      runs: [],
      ticks: 0,
    });
  });

  it("spawns the job when that payload reaches the port, exactly as a tick does", () => {
    const run = testProgram(cronProgram(options)).send("run", {});
    expect(run.effects).toContainEqual(
      spawn(jobRef, { on: { result: "result" } }),
    );
  });

  it("leaves `ticks` alone, because an on-demand run is not something the timer did", () => {
    expect(testProgram(cronProgram(options)).send("run", {}).state.ticks).toBe(
      0,
    );
  });

  it("records nothing and keeps its state when a job is already running", () => {
    const running = testProgram(cronProgram(options))
      .event({ type: "tick" })
      .event({ type: "spawned", process: child, program: "cron-job" });
    const asked = running.send("run", {});
    expect(asked.effects.filter((effect) => effect.type === "spawn")).toEqual(
      [],
    );
    expect(asked.state).toEqual(running.state);
    // The tile was already saying so, which is why the cell writes nothing down.
    expect(running.effects).toContainEqual(
      emit(STATUS_PORT, "running since 07:00:12"),
    );
  });
});

describe("cron's job shape against a real session row", () => {
  it("declares the payloads the real ports admit", () => {
    const ports = portsOf(session());
    expect(
      ports.prompt?.accepts({ text: "hi", key: "k", timestamp: SEVEN }),
    ).toBe(true);
    // Both halves of the shape, checked by the row's own predicates rather than by a copy.
    expect(ports.result?.accepts(turn("done", true))).toBe(true);
    expect(ports.prompt?.direction).toBe("in");
    expect(ports.result?.direction).toBe("out");
  });

  /**
   * The case this file exists to keep honest, and it reads the other way round now. A live session
   * row used to read as `{in: {}, out: {}}` — hand-written predicates with no schema to compare —
   * so a wrapper stood between the config and the arg. #8887 taught `shapeOf` to read a compiled
   * row and #8959 gave those rows their schemas, so the row fits on its own. `shapeOf` and
   * `fillArgs` are not public, so the fit is asserted where a consumer meets it: `cron(…)` runs the
   * fill inside `defineProgram` and throws on a job that does not fit, so a call that returns *is*
   * the fit. The day one of the session's ports stops publishing a payload schema, this throws.
   */
  it("is fitted by the live row itself, which is why no wrapper stands here", () => {
    expect(() =>
      cron({ ...options, job: session() as ShapeSource }),
    ).not.toThrow();
    expect(() =>
      cron({ ...options, job: { id: "not-a-job", ports: {} } as ShapeSource }),
    ).toThrow();
  });

  /**
   * The other half of the same seam: the wrapper is what a spawn on the arg actually resolves
   * through, so the row has to carry it as a `fill` (#8762). Without this the tick spawns the arg's
   * own service key and the registry answers `UnknownProgram: tuval/arg/cron/job`.
   */
  it("puts the job on the row's fill, so a spawn on the arg resolves to the session", () => {
    const row = cron({ ...options, job: session() as ShapeSource });
    expect(row.args).toEqual({ job: "tuval/arg/cron/job" });
  });

  it("keeps the real row's id, so the label names the session", () => {
    const row = cron({ ...options, job: session() as ShapeSource });
    expect(row.label).toBe("cron (claude-session)");
    // The shape is declared over the shipped AI-agent payloads themselves; nothing re-states them.
    expect(jobShape).toEqual(
      Program.shape({
        in: { prompt: PromptPayloadSchema },
        out: { result: TurnResultSchema },
      }),
    );
  });
});

/**
 * The consumer path, end to end and from outside: the fixture `.tuval/tuval.config.ts` beside this
 * package builds its row through `@kampus/tuval-cron`'s own entry and `@kampus/tuval/sessions`,
 * exactly as a user's config does. Nothing here boots a desk or spends a token — a row is a record.
 */
describe("a user's `.tuval/tuval.config.ts`", () => {
  it("builds a cron row through the package's entry, with the id the graph node names", () => {
    expect(standup.id).toBe("cron");
    expect(standup.label).toBe("cron (claude-session)");
    expect(config.programs.map((row) => row.id)).toContain("cron");
    expect(config.graph.nodes.map((node) => node.program)).toContain("cron");
  });

  /** And the two-cron half of the same path: a named second row, from outside, in one config. */
  it("carries a second, named cron beside it without either colliding", () => {
    expect(eveningSummary.id).toBe("evening-summary");
    expect(eveningSummary.label).toBe("evening-summary (claude-session)");
    expect(eveningSummary.args).toEqual({
      job: "tuval/arg/evening-summary/job",
    });
    expect(config.programs.map((row) => row.id)).toEqual([
      "cron",
      "evening-summary",
    ]);
    expect(config.graph.nodes.map((node) => node.id)).toEqual([
      "cron",
      "evening-summary",
    ]);
  });

  it("carries the `run` in-port `:cron run` lands on, and the two tile ports", () => {
    const ports = portsOf(standup);
    expect(ports.run?.direction).toBe("in");
    expect(ports.run?.accepts({})).toBe(true);
    expect(Object.keys(ports)).toEqual(
      expect.arrayContaining([TITLE_PORT, STATUS_PORT]),
    );
  });

  /**
   * The row a config hands the kernel is what a `graph` route is wired against, so the port has to
   * be on *that*, not only in the authored record. `standup.ports.result` is still `undefined` —
   * `result` is the cell the child's reply lands on and `jobShape`'s port on the job's side, and
   * neither is cron's own announcement.
   */
  it("carries the `brief` out-port a finished turn leaves on", () => {
    const ports = portsOf(standup);
    expect(ports[BRIEF_PORT]?.direction).toBe("out");
    expect(ports[BRIEF_PORT]?.accepts(turn("3 PRs merged", true))).toBe(true);
    expect(ports[BRIEF_PORT]?.accepts({ text: "no items" })).toBe(false);
    expect(ports.result).toBeUndefined();
  });

  it("gives every cron its own `brief`, so two crons are two routes", () => {
    expect(portsOf(eveningSummary)[BRIEF_PORT]?.direction).toBe("out");
    expect(portsOf(standup)[BRIEF_PORT]?.kind).not.toBe(
      portsOf(eveningSummary)[BRIEF_PORT]?.kind,
    );
  });

  it("registers the `run` spell under the program id, which is what `:cron run` resolves", () => {
    expect(standup.spells?.map((spell) => spell.path)).toContainEqual(["run"]);
  });
});

/**
 * Several crons in one config — a morning brief and an evening summary — which is one question:
 * what does a second cron collide with the first on if nobody names it? Three things at once, and
 * each assertion below is one of them.
 */
describe("more than one cron in a config", () => {
  const named = (id: string, schedule: string): AnyProgram =>
    cron({
      id,
      schedule,
      prompt: "what changed?",
      now: () => SEVEN,
      job: session() as ShapeSource,
    });

  it("gives each row its own program id, which is its graph node and its spell", () => {
    const morning = named("morning-brief", "0 7 * * *");
    const evening = named("evening-summary", "0 18 * * *");
    expect([morning.id, evening.id]).toEqual([
      "morning-brief",
      "evening-summary",
    ]);
    // The spell path is `run` on each; what makes `:morning-brief run` and `:evening-summary run`
    // two different spells is the program each is registered under, which is the id above.
    expect(morning.spells?.map((spell) => spell.path)).toContainEqual(["run"]);
    expect(evening.spells?.map((spell) => spell.path)).toContainEqual(["run"]);
  });

  it("keys each row's `job` fill under its own id, so neither reads the other's", () => {
    const morning = named("morning-brief", "0 7 * * *");
    const evening = named("evening-summary", "0 18 * * *");
    expect(morning.args).toEqual({ job: "tuval/arg/morning-brief/job" });
    expect(evening.args).toEqual({ job: "tuval/arg/evening-summary/job" });
  });

  it("names the cron on its own tile, so two tiles are not both `cron · …`", () => {
    expect(named("morning-brief", "0 7 * * *").label).toBe(
      "morning-brief (claude-session)",
    );
    expect(
      testProgram(
        cronProgram({
          id: "morning-brief",
          schedule: "0 7 * * *",
          prompt: "what changed?",
          now: () => SEVEN,
        }),
      ).effects,
    ).toContainEqual(emit(TITLE_PORT, "morning-brief · daily 07:00"));
  });

  it("leaves a config that names no id exactly where it was", () => {
    const row = cron({ ...options, job: session() as ShapeSource });
    expect(row.id).toBe("cron");
    expect(row.label).toBe("cron (claude-session)");
    expect(row.args).toEqual({ job: "tuval/arg/cron/job" });
    expect(testProgram(cronProgram(options)).effects).toContainEqual(
      emit(TITLE_PORT, "cron · every 60s"),
    );
  });

  it("refuses an id that is not a word, at the config call rather than at boot", () => {
    expect(() => named("", "0 7 * * *")).toThrow(/non-empty word/);
    expect(() => named("   ", "0 7 * * *")).toThrow(/non-empty word/);
    // A space would break the spell into `:morning` plus an argument, which addresses nothing.
    expect(() => named("morning brief", "0 7 * * *")).toThrow(/no spaces/);
  });
});

describe("cron's window", () => {
  it("names a module renderer on the row, which is the only kind a page can load", () => {
    // `defineProgram` compiles an authored `window` into a `host-native` reference whose renderer
    // is seated in a map inside the kernel process — unreachable from the browser tab that has to
    // mount it (kamp-us/phoenix #8811, open). A `kind: "module"` reference is the route that
    // crosses: the page resolves the specifier itself at boot (ADR 0359).
    const row = cron({ ...options, job: session() });
    expect(row.renderer).toEqual({
      kind: "module",
      ref: "@kampus/tuval-cron/window",
    });
    expect(row.renderer).toBe(CRON_WINDOW_REF);
  });

  it("gives every cron in a config the same specifier, because one module answers them all", () => {
    // The seat is keyed by the specifier, and `admits` is over the *state*, not the id. Two crons
    // are two processes over one renderer, exactly as two counters are.
    const first = cron({ ...options, id: "morning-brief", job: session() });
    const second = cron({ ...options, id: "evening-wrap", job: session() });
    expect(first.renderer).toEqual(second.renderer);
  });
});
