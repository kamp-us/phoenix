/**
 * `shell`, driven with `testProgram` — no kernel, no desk, and (bar one case that says so) no child
 * process. A `finished` event is fed in directly, which is what the handler answers with, so every
 * cell is pinned without spending a process id; `run.unit.test.ts` is where real children live.
 *
 * The one cast in this file is `drive`, and it is `testProgram`'s signature rather than this
 * program's: `defineProgram` grew `X` in #9294 and `testProgram` did not, so an `update` whose cells
 * answer `Answer<S, Run>` does not fit a helper that still says `Answer<S>`. The types it casts to
 * are the program's own, exported for exactly this.
 */

import {
  isTurnResult,
  type PromptPayload,
  type TurnResult,
} from "@kampus/tuval/ai-agent/ports";
import {
  type AnyProgram,
  type AuthoredProgram,
  emit,
  STATUS_PORT,
  TITLE_PORT,
  testProgram,
} from "@kampus/tuval/authoring";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Finished, ShellCommand } from "./run.ts";
import { RUN, type Run, runHandler, ShellRunner } from "./runner.ts";
import {
  DEFAULT_SHELL,
  type ShellOptions,
  type ShellPorts,
  type ShellUpdate,
  shell,
  shellProgram,
} from "./shell.ts";
import type { ShellState } from "./state.ts";

const AT = new Date(2026, 8, 10, 7, 0, 12).getTime();

const options: ShellOptions = { cwd: "/Users/can/phoenix" };

/** The authored record under `testProgram`. See the file header for the one cast. */
const drive = (over: ShellOptions = options) =>
  testProgram(
    shellProgram(over) as unknown as AuthoredProgram<
      ShellState,
      ShellPorts,
      ShellUpdate
    >,
  );

/** The runs a step asked for. A step that asked for none answers `[]`. */
const runsIn = (effects: ReadonlyArray<{ type: string }>): ReadonlyArray<Run> =>
  effects.filter(
    (effect) => effect.type === RUN,
  ) as unknown as ReadonlyArray<Run>;

/** The run a step asked for, or `undefined` when it asked for none. */
const askedRun = (effects: ReadonlyArray<{ type: string }>): Run | undefined =>
  runsIn(effects)[0];

/** A runner that reports whatever a case wants, and writes down what it was handed. */
const fakeRunner = (finish: (command: ShellCommand) => Finished) => {
  const seen: Array<ShellCommand> = [];
  const context = ShellRunner.context({
    start: (command) => {
      seen.push(command);
      return Effect.succeed(finish(command));
    },
  });
  return { context, seen };
};

/** The handler on a compiled row, as the actor would reach it: by the effect's own tag. */
const handlerOn = (row: AnyProgram) =>
  row.handlers[RUN] as (effect: Run) => Effect.Effect<ReadonlyArray<Finished>>;

const prompt = (text: string, key = "k1"): PromptPayload => ({
  text,
  key,
  timestamp: AT,
});

const finished = (over: Partial<Finished> = {}): Finished => ({
  type: "finished",
  key: "k1",
  code: 0,
  output: "hi\n",
  timedOut: false,
  durationMs: 1_234,
  ...over,
});

/** The `result` payload of one run, as the emit carries it. */
const answered = (effects: ReadonlyArray<unknown>): TurnResult => {
  const emitted = effects.find(
    (effect) =>
      typeof effect === "object" &&
      effect !== null &&
      (effect as { type?: unknown }).type === "emit" &&
      (effect as { port?: unknown }).port === "result",
  ) as { readonly payload: unknown } | undefined;
  if (emitted === undefined) throw new Error("nothing was emitted on `result`");
  if (!isTurnResult(emitted.payload)) {
    throw new Error("what was emitted on `result` is not a TurnResult");
  }
  return emitted.payload;
};

describe("a shell before anything has been asked of it", () => {
  it("says what it is and that it is idle, and starts nothing", () => {
    const run = drive();
    expect(run.state).toEqual({
      id: "shell",
      cwd: "/Users/can/phoenix",
      running: null,
      last: null,
    });
    expect(run.effects).toEqual([
      emit(TITLE_PORT, "shell · phoenix"),
      emit(STATUS_PORT, "idle"),
    ]);
  });

  /**
   * The whole of "never on init, never on a timer", and it is structural rather than a rule
   * somebody remembered: a run happens because a cell asked for one, and `init` asks for nothing.
   * The program declares no Subs at all — the child used to be one, and performing work in a
   * subscription is the thing this package no longer does (#8716 R12.1).
   */
  it("asks for no run, because no cell has decided to start one", () => {
    expect(askedRun(drive().effects)).toBeUndefined();
    expect(shellProgram(options)).not.toHaveProperty("subs");
  });
});

describe("a shell, asked to run something", () => {
  const asked = (over: ShellOptions = options) =>
    drive(over).send("prompt", prompt("git fetch --all"));

  it("puts the command on state and asks for the run — the handler is what starts it", () => {
    const run = asked();
    expect(run.state.running).toEqual({
      key: "k1",
      command: "git fetch --all",
      startedAt: AT,
    });
    expect(run.effects.filter((effect) => effect.type === "emit")).toEqual([
      emit(STATUS_PORT, "running git fetch --all"),
    ]);
  });

  /**
   * The ask is a finished decision: the prompt's key and command, and the config's directory,
   * interpreter and timeout. Nothing is left for the handler to work out, which is why the handler
   * can be a translation of `./run.ts` and nothing more.
   */
  it("asks for exactly one run, carrying the request and the config it runs under", () => {
    const run = asked({ ...options, timeoutMs: 5_000, env: { TZ: "UTC" } });
    expect(runsIn(run.effects)).toHaveLength(1);
    expect(askedRun(run.effects)).toEqual({
      type: RUN,
      key: "k1",
      command: "git fetch --all",
      cwd: "/Users/can/phoenix",
      shell: DEFAULT_SHELL,
      timeoutMs: 5_000,
      env: { TZ: "UTC" },
    });
  });

  it("asks for nothing when it is already running, so a refusal starts no second child", () => {
    const busy = asked().send("prompt", prompt("printf second", "k2"));
    expect(askedRun(busy.effects)).toBeUndefined();
  });

  it("says on the tile what it is running", () => {
    expect(asked().effects).toContainEqual(
      emit(STATUS_PORT, "running git fetch --all"),
    );
  });
});

describe("a command that succeeded", () => {
  const done = () =>
    drive().send("prompt", prompt("printf hi")).event(finished());

  it("answers a turn whose text is the output and whose verdict is the exit code", () => {
    const turn = answered(done().effects);
    expect(turn.text).toBe("hi\n");
    expect(turn.ok).toBe(true);
  });

  it("writes the run down, clears the request and asks for no further run", () => {
    const run = done();
    expect(run.state.running).toBeNull();
    expect(run.state.last).toEqual({
      key: "k1",
      command: "printf hi",
      startedAt: AT,
      ending: { _tag: "exit", code: 0 },
      durationMs: 1_234,
    });
    expect(askedRun(run.effects)).toBeUndefined();
  });

  it("says `exit 0 in 1.2s` on the tile", () => {
    expect(done().effects).toContainEqual(emit(STATUS_PORT, "exit 0 in 1.2s"));
  });

  /**
   * The items question, answered rather than dodged. `TranscriptItem`'s union has a `tool` member —
   * "a named thing ran with this input and produced this result" — which is exactly what happened,
   * so the array carries one honest item instead of being empty. It is the port's own predicate
   * that says the item is well-formed here, not a copy of one.
   */
  it("carries the run as one well-formed tool item, not an empty array", () => {
    const turn = answered(done().effects);
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0]).toMatchObject({
      kind: "tool",
      id: "k1",
      name: "shell",
      input: { command: "printf hi", cwd: "/Users/can/phoenix" },
      status: "ok",
      result: { text: "hi\n", omitted: { bytes: 0 } },
    });
    // `isTurnResult` runs `isTranscriptItem` over every item, and `answered` already ran it.
    expect(isTurnResult(turn)).toBe(true);
  });

  it("takes another command afterwards, because the run that answered is over", () => {
    const again = done().send("prompt", prompt("printf again", "k2"));
    expect(again.state.running?.command).toBe("printf again");
  });
});

describe("a command that failed", () => {
  it("answers a failed turn with the output, and keeps the exit code on the tile", () => {
    const run = drive()
      .send("prompt", prompt("exit 3"))
      .event(finished({ code: 3, output: "boom\n" }));
    const turn = answered(run.effects);
    expect(turn.ok).toBe(false);
    expect(turn.text).toBe("boom\n");
    expect(turn.items[0]).toMatchObject({ status: "error" });
    expect(run.effects).toContainEqual(emit(STATUS_PORT, "exit 3 in 1.2s"));
  });

  it("reads a run that never started as killed, with the reason as its text", () => {
    const run = drive()
      .send("prompt", prompt("printf hi"))
      .event(finished({ code: null, output: "spawn ENOENT\n" }));
    expect(run.state.last?.ending).toEqual({ _tag: "killed" });
    expect(answered(run.effects).ok).toBe(false);
    expect(run.effects).toContainEqual(emit(STATUS_PORT, "killed after 1.2s"));
  });
});

describe("a command that ran too long", () => {
  it("answers a failed turn and says the timeout is what ended it", () => {
    const run = drive({ ...options, timeoutMs: 5_000 })
      .send("prompt", prompt("sleep 30"))
      .event(finished({ code: null, timedOut: true, durationMs: 5_003 }));
    expect(run.state.last?.ending).toEqual({ _tag: "timeout" });
    expect(answered(run.effects).ok).toBe(false);
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "timed out after 5.0s"),
    );
    expect(run.state.running).toBeNull();
  });

  it("refuses a timeout that would kill every command before it ran", () => {
    expect(() => shell({ ...options, timeoutMs: 0 })).toThrow(/positive/);
    expect(() => shell({ ...options, timeoutMs: -1 })).toThrow(/positive/);
  });
});

describe("a prompt that lands while a command is running", () => {
  const busy = () =>
    drive()
      .send("prompt", prompt("sleep 30"))
      .send("prompt", prompt("printf second", "k2"));

  /**
   * Refused rather than dropped, and that is the whole reason this cell exists: the caller is
   * waiting on `result`, so a prompt swallowed in silence is a caller hung for ever.
   */
  it("answers it immediately with a failed turn saying what is running", () => {
    const turn = answered(busy().effects);
    expect(turn.ok).toBe(false);
    expect(turn.text).toContain("already running sleep 30");
    expect(turn.items[0]).toMatchObject({ kind: "system", id: "k2-refused" });
  });

  it("leaves the running command exactly as it was", () => {
    expect(busy().state.running).toEqual({
      key: "k1",
      command: "sleep 30",
      startedAt: AT,
    });
  });
});

describe("a finish that does not belong to the running command", () => {
  it("is ignored, because a second `result` would answer a turn twice", () => {
    const run = drive()
      .send("prompt", prompt("sleep 30"))
      .event(finished({ key: "someone-else" }));
    expect(run.state.running).not.toBeNull();
    expect(run.effects).toEqual([]);
  });

  it("is ignored when nothing is running at all", () => {
    const run = drive().event(finished());
    expect(run.state.last).toBeNull();
    expect(run.effects).toEqual([]);
  });
});

describe("a shell restarted mid-command", () => {
  const cut = () => drive().send("prompt", prompt("make install"));

  const restarted = () =>
    shellProgram(options)
      .resume(cut().state)
      .reduce((run, event) => run.event(event), cut());

  it("asks to reconcile on every restore, holding a command or not", () => {
    expect(shellProgram(options).resume(cut().state)).toEqual([
      { type: "restored" },
    ]);
    expect(shell(options).resume?.(cut().state)).toEqual([
      { type: "restored" },
    ]);
  });

  /**
   * The one thing a shell job must never do: `rm -rf build && make install` is not something to
   * replay because a desk was restarted. `restored` asks for no run, so nothing is re-started.
   */
  it("clears the request and asks for no run, so the command is not re-run", () => {
    const run = restarted();
    expect(run.state.running).toBeNull();
    expect(askedRun(run.effects)).toBeUndefined();
    expect(run.state.last?.ending).toEqual({ _tag: "interrupted" });
    expect(run.effects).toContainEqual(
      emit(STATUS_PORT, "interrupted by restart"),
    );
  });

  it("emits no `result` for it, because the caller is being restored too", () => {
    expect(
      restarted().effects.filter(
        (effect) => effect.type === "emit" && effect.port === "result",
      ),
    ).toEqual([]);
  });

  it("re-reads `id` and `cwd` off the config, so a checkpoint cannot pin a stale directory", () => {
    const stale: ShellState = {
      ...cut().state,
      id: "shell",
      cwd: "/somewhere/it/used/to/be",
    };
    const moved = shellProgram({ ...options, id: "fetcher", cwd: "/tmp/now" });
    const [back] = moved.update.restored(stale, { type: "restored" });
    expect(back.id).toBe("fetcher");
    expect(back.cwd).toBe("/tmp/now");
  });

  it("takes another command straight away", () => {
    const again = restarted().send("prompt", prompt("printf again", "k2"));
    expect(again.state.running?.command).toBe("printf again");
  });
});

describe("the row a config writes", () => {
  it("defaults its id, and names the directory on its label", () => {
    const row = shell(options);
    expect(row.id).toBe("shell");
    expect(row.label).toBe("shell (phoenix)");
  });

  it("takes an id, so two shells in one config are two programs and two graph nodes", () => {
    const first = shell({ ...options, id: "fetcher" });
    const second = shell({ cwd: "/tmp", id: "cleaner" });
    expect([first.id, second.id]).toEqual(["fetcher", "cleaner"]);
    expect(first.label).toBe("fetcher (phoenix)");
    expect(second.label).toBe("cleaner (tmp)");
    expect(drive({ ...options, id: "fetcher" }).effects).toContainEqual(
      emit(TITLE_PORT, "fetcher · phoenix"),
    );
  });

  it("refuses an id that is not a word, at the config call rather than at boot", () => {
    expect(() => shell({ ...options, id: "" })).toThrow(/non-empty word/);
    expect(() => shell({ ...options, id: "   " })).toThrow(/non-empty word/);
    expect(() => shell({ ...options, id: "my shell" })).toThrow(/no spaces/);
  });

  it("carries the two ports a job owes, and the two tile ports", () => {
    const row = shell(options);
    expect(row.ports.prompt?.direction).toBe("in");
    expect(row.ports.result?.direction).toBe("out");
    expect(row.ports.prompt?.accepts(prompt("hi"))).toBe(true);
    expect(Object.keys(row.ports)).toEqual(
      expect.arrayContaining([TITLE_PORT, STATUS_PORT]),
    );
  });

  it("takes `/bin/zsh` when a config names no interpreter", () => {
    expect(DEFAULT_SHELL).toBe("/bin/zsh");
  });
});

/**
 * The seam itself, both halves and in one pass, against a runner that spawns nothing: the prompt's
 * cell answers a `Run`, the handler *the compiled row carries* is fetched by the tag the actor
 * dispatches on, run on that very effect, and the events it answers are fed back into the program —
 * where they come out as a `result`. Nothing is hand-carried but the loop the actor would run.
 */
describe("the handler on the row, with a fake runner", () => {
  const ending = (command: ShellCommand): Finished => ({
    type: "finished",
    key: command.key,
    code: 0,
    output: `ran ${command.command} in ${command.cwd}\n`,
    timedOut: false,
    durationMs: 7,
  });

  it("is on the row under the tag the actor dispatches on", () => {
    expect(typeof shell(options).handlers[RUN]).toBe("function");
  });

  it("is handed the effect the cell asked for, and its events reach `update`", async () => {
    const runner = fakeRunner(ending);
    const asked = drive().send("prompt", prompt("printf hi"));
    const effect = askedRun(asked.effects);
    if (effect === undefined) throw new Error("no run was asked for");

    const events = await Effect.runPromise(
      handlerOn(shell(options, runner.context))(effect),
    );

    // The effect itself, not a copy of it: `Run` *is* a `ShellCommand` with a tag on it, so the
    // handler hands the runner what the cell asked for and works nothing out on the way.
    expect(runner.seen).toEqual([effect]);
    expect(runner.seen[0]).toMatchObject({
      key: "k1",
      command: "printf hi",
      cwd: "/Users/can/phoenix",
      shell: DEFAULT_SHELL,
      timeoutMs: null,
    });
    expect(events).toHaveLength(1);

    const run = events.reduce((step, event) => step.event(event), asked);
    const turn = answered(run.effects);
    expect(turn.text).toBe("ran printf hi in /Users/can/phoenix\n");
    expect(turn.ok).toBe(true);
    expect(run.state.running).toBeNull();
    expect(run.state.last?.durationMs).toBe(7);
  });

  it("answers a list, because that is what a `HostHandlers` handler owes", async () => {
    const runner = fakeRunner(ending);
    const events = await Effect.runPromise(
      handlerOn(shell(options, runner.context))({
        type: RUN,
        key: "k9",
        command: "true",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeoutMs: null,
      }),
    );
    expect(Array.isArray(events)).toBe(true);
    expect(events[0]).toMatchObject({ type: "finished", key: "k9" });
  });
});

/**
 * One case with a real child in it, and it is here rather than in `run.unit.test.ts` because what
 * it pins is the *wiring*: the handler the shipped row carries, run on the effect the program
 * asked for, whose events go back into the program and come out as a `result`. Everything between
 * the prompt and the answer, with nothing hand-carried and no fake anywhere.
 */
describe("the handler, with a real child", () => {
  it("runs the prompted command and its report answers the turn", async () => {
    const real = { cwd: "/tmp", shell: "/bin/sh" };
    const asked = drive(real).send("prompt", prompt("printf hi"));
    const effect = askedRun(asked.effects);
    if (effect === undefined) throw new Error("no run was asked for");

    const events = await Effect.runPromise(handlerOn(shell(real))(effect));

    const run = events.reduce((step, event) => step.event(event), asked);
    const turn = answered(run.effects);
    expect(turn.text).toBe("hi");
    expect(turn.ok).toBe(true);
    expect(run.state.running).toBeNull();
  });
});

/**
 * The failure mode the whole program turns on: a run that never reports leaves `state.running` set,
 * so the tile says `running …` for ever, every later prompt is refused as busy, and the caller
 * waiting on `result` is hung. The handler therefore answers a `finished` whatever happens — a
 * defect included — and `endingOf` reads a run with no exit code as `killed`, which is what the
 * async spawn failure has always produced.
 */
describe("a run that dies before it can report", () => {
  const ask = (command: string): Run => ({
    type: RUN,
    key: "k1",
    command,
    cwd: "/tmp",
    shell: "/bin/sh",
    timeoutMs: null,
  });

  it("answers `killed` when the runner throws synchronously, rather than wedging the state", async () => {
    const context = ShellRunner.context({
      start: () => {
        throw new Error("no runner here");
      },
    });
    const events = await Effect.runPromise(runHandler(context)(ask("true")));
    expect(events).toEqual([
      {
        type: "finished",
        key: "k1",
        code: null,
        output: "no runner here\n",
        timedOut: false,
        durationMs: 0,
      },
    ]);
  });

  /**
   * The live path, and it is reachable rather than theoretical: the command is whatever text landed
   * on the port, and `child_process.spawn` throws `ERR_INVALID_ARG_VALUE` *synchronously* on an
   * argument holding a NUL byte — before any `error` event exists to report it.
   */
  it("answers `killed` when a real `spawn` throws before the child exists", async () => {
    const events = await Effect.runPromise(
      runHandler()(ask(`printf hi${String.fromCharCode(0)}`)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "k1", code: null, timedOut: false });
    expect(events[0]?.output).toContain("null bytes");
  });

  it("is a failed turn that clears the request, once it reaches `update`", async () => {
    const context = ShellRunner.context({
      start: () => {
        throw new Error("no runner here");
      },
    });
    const asked = drive({ cwd: "/tmp", shell: "/bin/sh" }).send(
      "prompt",
      prompt("true"),
    );
    const effect = askedRun(asked.effects);
    if (effect === undefined) throw new Error("no run was asked for");

    const events = await Effect.runPromise(runHandler(context)(effect));
    const run = events.reduce((step, event) => step.event(event), asked);
    expect(run.state.running).toBeNull();
    expect(run.state.last?.ending).toEqual({ _tag: "killed" });
    expect(answered(run.effects).ok).toBe(false);
  });
});

/**
 * The runner is a service so that the handler can be tested without a process, and so that a
 * failure mode with no child in it — a runner that never reports — is reachable. Interruption is
 * the handler's, not a Sub's: `startCommand`'s abandon hangs on the Effect's own finalizer.
 *
 * An interruption is *not* a defect and is deliberately not turned into a `finished`: an abandoned
 * run is one nobody is waiting for any more.
 */
describe("a run that is interrupted", () => {
  it("abandons through the Effect's finalizer rather than a Sub's dispose", async () => {
    let abandoned = false;
    const context = ShellRunner.context({
      start: () =>
        Effect.callback<Finished>(() =>
          Effect.sync(() => {
            abandoned = true;
          }),
        ),
    });
    const handler = runHandler(context);
    await Effect.runPromise(
      Effect.timeoutOption(
        handler({
          type: RUN,
          key: "k1",
          command: "sleep 30",
          cwd: "/tmp",
          shell: "/bin/sh",
          timeoutMs: null,
        }),
        10,
      ),
    );
    expect(abandoned).toBe(true);
  });
});
