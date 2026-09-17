/** @jsxRuntime automatic @jsxImportSource react */

/*
 * The pragma above is not decoration. esbuild — which is what Vite transforms this file with when
 * a desk serves it — reads its JSX setting off the nearest `tsconfig.json`, and here that is the
 * kernel lens, which excludes this file and declares no `jsx` at all. Without the pragma esbuild
 * falls back to the classic `React.createElement` transform and every render throws
 * `React is not defined`. `tsconfig.window.json` already says `react-jsx`; this line is that same
 * fact, where the bundler can see it.
 */

/**
 * The workspaces, as a window: one row per provisioned set, with the four declared inputs resolved
 * — path, branch, port, what the agent is doing — and a Close on each.
 *
 * **Why a window when there is already a tile.** The tile holds two lines and there are up to eight
 * workspaces. The whole value of this program is seeing, at once, that `feature-x` is on `:5174`
 * and `bugfix` is on `:5175` and neither is about to trip over the other; one line cannot say that
 * and a list can.
 *
 * **What this module may import.** `@kampus/tuval/window` (the browser-safe door, whose own closure
 * reaches no `node:` builtin), `react`, and this package's kernel-free `./state.ts`. It must not
 * reach `./workspace.ts`: that file imports `@kampus/tuval/authoring` (and `node:path`), and the
 * page loads this module in a browser tab.
 *
 * **Open and Close are dispatches, not spell calls.** `WindowHost` carries `readProcess`,
 * `dispatch`, `view` and `setView`, and no way to call a spell. That is not a gap here: both spells
 * are themselves bare `send`s, so the arrival a spell produces and the event a button dispatches
 * are the same event landing in the same cell.
 */

import type { WindowHost } from "@kampus/tuval/window";
import { windowRenderer } from "@kampus/tuval/window";
import { Effect, Fiber, Stream } from "effect";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import type {
  WorkspaceCommandEvent,
  WorkspaceRowView,
  WorkspaceState,
  WorkspaceWindowView,
} from "./state.ts";
import { closeEvent, discardEvent, openEvent, workspaceView } from "./state.ts";

/** The predicate the page admits this renderer's state through (ADR 0358). */
export { isWorkspaceState as admits } from "./state.ts";

type Host = WindowHost<WorkspaceState, WorkspaceCommandEvent>;

/**
 * This process's public state, live. The stream never fails and ends on `ProcessGone`, so there is
 * no error arm: `null` is "nothing yet", and a gone process simply stops updating.
 */
const useWorkspaceState = (host: Host): WorkspaceState | null => {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const read = host.readProcess;
  useEffect(() => {
    const fiber = Effect.runFork(
      Stream.runForEach(read, (view) =>
        Effect.sync(() => {
          if (view._tag === "Live") setState(view.state);
        }),
      ),
    );
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }, [read]);
  return state;
};

// Inline rather than a stylesheet: a `.css` import would make this module's build a second step and
// its package a second file, for a window that is a header and a list.
const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "0.75rem",
    font: "inherit",
    height: "100%",
    boxSizing: "border-box",
    overflow: "auto",
  },
  header: { display: "flex", flexDirection: "column", gap: "0.15rem" },
  repo: { fontWeight: 600 },
  status: { opacity: 0.75 },
  inputs: { opacity: 0.6, fontSize: "0.85em" },
  controls: { display: "flex", alignItems: "center", gap: "0.5rem" },
  hint: { opacity: 0.6, fontSize: "0.85em" },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
    paddingBottom: "0.5rem",
    borderBottom: "1px solid currentColor",
    borderBottomColor: "rgba(128,128,128,0.25)",
  },
  line: { display: "flex", gap: "0.5rem", alignItems: "baseline" },
  name: { fontWeight: 600 },
  port: { fontVariantNumeric: "tabular-nums", opacity: 0.8 },
  meta: { opacity: 0.6, fontSize: "0.85em", overflowWrap: "anywhere" },
  detail: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", opacity: 0.85 },
  empty: { opacity: 0.6 },
  // The destructive control is pushed away from Close, greyed down and spelled out. Neighbouring
  // buttons that do very different things is how a misclick becomes a lost afternoon.
  danger: { marginLeft: "1.25rem", opacity: 0.75 },
  notice: {
    display: "flex",
    flexDirection: "column",
    gap: "0.15rem",
    fontSize: "0.85em",
    opacity: 0.8,
  },
  noticeHead: { fontWeight: 600 },
} satisfies Record<string, CSSProperties>;

function Row({
  row,
  onClose,
  onDiscard,
}: {
  readonly row: WorkspaceRowView;
  readonly onClose: (name: string) => void;
  readonly onDiscard: (name: string) => void;
}): ReactElement {
  return (
    <li style={styles.item}>
      <div style={styles.line}>
        <span style={styles.name}>{row.name}</span>
        <span style={styles.port}>{row.port}</span>
        <span>{row.status}</span>
        <span style={styles.hint}>{row.agent}</span>
        {/*
         * Close never forces. It sends the same arrival `:workspace close` does, so git is asked
         * without `--force` and a worktree holding uncommitted work refuses — the refusal lands on
         * this row's detail rather than the work landing nowhere.
         */}
        <button
          type="button"
          onClick={() => onClose(row.name)}
          disabled={!row.closable}
        >
          Close
        </button>
        <button
          type="button"
          style={styles.danger}
          title={`Force-remove ${row.name}'s worktree. Uncommitted work in it is lost.`}
          onClick={() => onDiscard(row.name)}
          disabled={!row.closable}
        >
          Discard (loses work)
        </button>
      </div>
      <span style={styles.meta}>
        {row.branch} · {row.path}
      </span>
      {row.detail === null ? null : (
        <span style={styles.detail}>{row.detail}</span>
      )}
    </li>
  );
}

function Rows({
  view,
  onClose,
  onDiscard,
}: {
  readonly view: WorkspaceWindowView;
  readonly onClose: (name: string) => void;
  readonly onDiscard: (name: string) => void;
}): ReactElement {
  if (view.rows.length === 0) return <p style={styles.empty}>{view.empty}</p>;
  return (
    <ul style={styles.list}>
      {view.rows.map((row) => (
        <Row key={row.key} row={row} onClose={onClose} onDiscard={onDiscard} />
      ))}
    </ul>
  );
}

/** The `open`s this program would not take, spelled out. Nothing drawn when there are none. */
function Refusals({
  view,
}: {
  readonly view: WorkspaceWindowView;
}): ReactElement | null {
  if (view.refusals.length === 0) return null;
  return (
    <section style={styles.notice} aria-label="refused opens">
      <span style={styles.noticeHead}>Refused</span>
      {view.refusals.map((refusal) => (
        <span key={refusal.key}>
          {refusal.name} — {refusal.text}
        </span>
      ))}
    </section>
  );
}

/** Turn results that belonged to no row, and the one line saying why they could not. */
function Unattributed({
  view,
}: {
  readonly view: WorkspaceWindowView;
}): ReactElement | null {
  if (view.unattributed.length === 0) return null;
  return (
    <section style={styles.notice} aria-label="unattributed results">
      <span style={styles.noticeHead}>Unattributed results</span>
      {view.unattributed.map((result) => (
        <span key={result.key}>{result.text}</span>
      ))}
      <span style={styles.hint}>{view.unattributedNote}</span>
    </section>
  );
}

/**
 * The window over one live workspace program. Everything it draws comes from `workspaceView`, which
 * is pure and tested on its own; this component decides nothing but where the lines go.
 */
function WorkspaceWindow({ host }: { readonly host: Host }): ReactElement {
  const state = useWorkspaceState(host);
  const [name, setName] = useState("");
  const open = useCallback(() => {
    const wanted = name.trim();
    if (wanted === "") return;
    void Effect.runFork(host.dispatch(openEvent(wanted)));
    setName("");
  }, [host, name]);
  // Close sends `closeEvent` and nothing else. There is no force variant of this callback, and the
  // forcing one below is a separate function reached by a separate, separately labelled button.
  const close = useCallback(
    (which: string) => {
      void Effect.runFork(host.dispatch(closeEvent(which)));
    },
    [host],
  );
  const discard = useCallback(
    (which: string) => {
      void Effect.runFork(host.dispatch(discardEvent(which)));
    },
    [host],
  );

  if (state === null) {
    return (
      <output style={styles.empty}>
        Waiting for the first state from this workspace program.
      </output>
    );
  }
  const view = workspaceView(state);
  return (
    <section style={styles.root} aria-label={`workspaces of ${view.repoName}`}>
      <header style={styles.header}>
        <span style={styles.repo}>{view.repoName}</span>
        <span style={styles.status}>{view.status}</span>
        <span style={styles.inputs}>
          {view.base} → {view.root}
        </span>
      </header>
      <div style={styles.controls}>
        <input
          type="text"
          value={name}
          placeholder="feature-x"
          aria-label="new workspace name"
          onChange={(change) => setName(change.target.value)}
          onKeyDown={(key) => {
            if (key.key === "Enter") open();
          }}
        />
        <button type="button" onClick={open} disabled={!view.canOpen}>
          Open
        </button>
        <span style={styles.hint}>
          {view.busy
            ? "Something is in flight — one provision at a time."
            : "same as :workspace open <name>"}
        </span>
      </div>
      <Refusals view={view} />
      <Rows view={view} onClose={close} onDiscard={discard} />
      <Unattributed view={view} />
    </section>
  );
}

/**
 * The contract a `kind: "module"` reference names. `windowRenderer` comes from the door rather than
 * being a hand-written `{kind, render}`, so the page's kind check (`module`, not `host-native`) is
 * satisfied by construction and not by a literal that could drift.
 */
export default windowRenderer("module", (host: Host) => (
  <WorkspaceWindow host={host} />
));
