/**
 * Shell's state, and everything that is a pure function of it — the leaf the program and its tests
 * share and neither owns.
 *
 * Nothing here imports `node:child_process` and nothing here imports the authoring door: this is the
 * shape of a run and the two lines a board tile draws from it, so the sentences a tile shows are
 * decided by a unit test rather than by watching a desk.
 *
 * **Two fields the reducer never writes.** `id` and `cwd` are env, not state: the config chose both
 * at `shell(...)` and nothing that happens to a run moves either. They are on the record because a
 * tile is drawn from this one thing, and "which shell, where" is the first question its title
 * answers. `init` seeds them and no cell touches them.
 */

/** The command a prompt asked for, while it is still running. */
export interface ShellRequest {
  /** The prompt's own `key`, which is also what the finish is matched against. */
  readonly key: string;
  /** What was asked, verbatim — the whole line, passed to the shell as one command. */
  readonly command: string;
  /** Epoch milliseconds, the prompt's own stamp: the sender's clock, since this program reads none. */
  readonly startedAt: number;
}

/**
 * How a run ended, as one closed union rather than a nullable code beside a pair of flags. A
 * `code: null, timedOut: false, interrupted: true` record admits states that cannot happen and
 * asks every reader to work out which combinations are real; these four are the whole of it, and
 * only `exit` carries a code because only `exit` has one.
 */
export type ShellEnding =
  /** The command finished on its own and said so. `0` is the only success. */
  | { readonly _tag: "exit"; readonly code: number }
  /** The timeout killed the process group. */
  | { readonly _tag: "timeout" }
  /** It ended with no code of its own: a signal, or a spawn that never happened at all. */
  | { readonly _tag: "killed" }
  /** A restart cut it in half. A restart is not an answer, so the run it interrupted is a failed one. */
  | { readonly _tag: "interrupted" };

/** One finished run, as the tile reports it. */
export interface ShellRun extends ShellRequest {
  readonly ending: ShellEnding;
  /** Wall-clock milliseconds the child was up, as the runner measured it. Zero for `interrupted`. */
  readonly durationMs: number;
}

/** The one definition of a good run: it exited, on its own, with zero. */
export const succeeded = (run: ShellRun): boolean =>
  run.ending._tag === "exit" && run.ending.code === 0;

export interface ShellState {
  /** What this shell is called: its program id and its graph node id. */
  readonly id: string;
  /** Where every command runs. Verbatim from the config; the tile shows its basename. */
  readonly cwd: string;
  /** The command running right now, or `null` when nothing is. */
  readonly running: ShellRequest | null;
  /** The last run that finished, or `null` before the first one does. */
  readonly last: ShellRun | null;
}

/** How much of a command the tile shows before it gives up and elides the rest. */
export const COMMAND_HEAD = 40;

/**
 * How many bytes of output a `TurnResult`'s `text` may carry. The **tail** is what is kept, because
 * a build that failed says so on its last line and a `find` that succeeded says nothing anywhere.
 */
export const OUTPUT_BYTE_LIMIT = 64 * 1024;

/** The tile's first line: which shell, and where it runs. */
export const basename = (cwd: string): string => {
  const trimmed = cwd.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name === "" ? "/" : name;
};

/** The head of a command, for a line that holds one. */
export const commandHead = (command: string): string => {
  const line = (command.split("\n")[0] ?? "").trim();
  return line.length <= COMMAND_HEAD
    ? line
    : `${line.slice(0, COMMAND_HEAD - 1)}…`;
};

/** `1.2s` — one decimal, because a tile that says `1234ms` makes a reader do the division. */
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * The status line, in one place, so the row's `status` and any reader of this package draw the same
 * sentence: `idle` before anything, `running <cmd head>` while a child is up, and the verdict of
 * the last run afterwards — one branch per ending, which is the union's own point.
 */
export const statusLine = (state: ShellState): string => {
  if (state.running !== null) {
    return `running ${commandHead(state.running.command)}`;
  }
  const last = state.last;
  if (last === null) return "idle";
  const took = seconds(last.durationMs);
  switch (last.ending._tag) {
    case "exit":
      return `exit ${last.ending.code} in ${took}`;
    case "timeout":
      return `timed out after ${took}`;
    case "killed":
      return `killed after ${took}`;
    case "interrupted":
      return "interrupted by restart";
  }
};

/** The tile's title: which shell, and the directory it runs in. */
export const titleLine = (state: ShellState): string =>
  `${state.id} · ${basename(state.cwd)}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

/** What a bounded output says in place of the bytes it dropped. */
export const droppedNote = (bytes: number): string =>
  `[… ${bytes} bytes of earlier output dropped]\n`;

/**
 * The last `limit` bytes of an output, with a line saying how much was dropped. The cut lands on a
 * code-point boundary — a UTF-8 continuation byte is `10xxxxxx`, so walking *forward* off one
 * reaches the start of the next whole character and the kept tail decodes without a replacement
 * character.
 *
 * The note is prepended rather than the drop being silent, because an output that lies about being
 * whole is worse than one that is short: a reader who sees `exit 0` over a truncated log has no way
 * to tell which.
 *
 * `alreadyDropped` is what a reader lost *before* this call — `./run.ts` holds a rolling window, so
 * a gigabyte of output is already short by the time the cut sees it. It is added to the note rather
 * than written as a second one, so an output carries one honest number instead of two partial ones.
 */
export const boundedTail = (
  text: string,
  limit: number = OUTPUT_BYTE_LIMIT,
  alreadyDropped = 0,
): string => {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) {
    return alreadyDropped === 0 ? text : droppedNote(alreadyDropped) + text;
  }
  let start = bytes.length - limit;
  while (start < bytes.length) {
    const byte = bytes[start] ?? 0;
    if (byte < 0x80 || byte >= 0xc0) break;
    start += 1;
  }
  return (
    droppedNote(alreadyDropped + start) + decoder.decode(bytes.subarray(start))
  );
};
