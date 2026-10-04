---
id: 0462
title: Tuval runs each Pi host in a child process of the desk, never inside the desk process
status: accepted
date: 2026-10-04
tags: [tuval, pi, architecture]
---

# 0462 — Tuval runs each Pi host in a child process of the desk, never inside the desk process

**What this decides:** the code that runs a Pi coding agent moves out of the desk's own Node
process into a separate one the desk starts, so a Pi loop that pins a CPU cannot freeze the page or
hold up other programs' saves.

## Context

On 2026-09-07 a Pi streaming turn pinned the desk process at 100% CPU. A fresh browser tab could
not load the desk for minutes, 14 checkpoint temp files sat in flight at once, and the log carried a
`tuval/host/StoreError` on a checkpoint rename
([#8516](https://github.com/kamp-us/phoenix/issues/8516)). The hot code was the Pi wire codec. That
bug had its own ticket ([#8515](https://github.com/kamp-us/phoenix/issues/8515)) and its own
records, the since-superseded ADR [0364](0364-pi-protocol-compiled-validators-patch.md) and then
ADR [0366](0366-tuval-keeps-own-pi-host.md), and it is closed. This record is about what the codec bug
exposed: one row's CPU work stalled the whole desk, because everything shares one event loop.

Three things run in the one process today:

- **Boot.** [`apps/tuval/src/bin.ts`](../apps/tuval/src/bin.ts)'s `runDesk` boots the kernel, binds
  the desk transport and calls `servePage`, all in the process `NodeRuntime.runMain` started.
- **Page.** [`apps/tuval/src/page/dev-server.ts`](../apps/tuval/src/page/dev-server.ts) creates a
  Vite server inside that process. The kernel's checkpoint writer,
  [`packages/tuval/src/durability/Checkpoints.ts`](../packages/tuval/src/durability/Checkpoints.ts),
  runs there too.
- **Pi.** Each Pi row builds `PiAiAgent.layer`
  ([`packages/tuval-pi/src/ai-agent/PiAiAgent.ts`](../packages/tuval-pi/src/ai-agent/PiAiAgent.ts)),
  which stands up four things in the desk process: Pi's model runtime, the session host
  ([`AgentSessionHost.ts`](../packages/tuval-pi/src/server/AgentSessionHost.ts)), a loopback
  WebSocket server on `127.0.0.1` port 0
  ([`PiServerService.ts`](../packages/tuval-pi/src/server/PiServerService.ts)), and a client that
  dials that server. `PiServerService`'s `write` calls `encodeServerMessage` synchronously.

So the two halves of the Pi socket already talk over a real loopback socket with a per-launch token.
They only happen to sit in one process. The paths above are where the code lives on `main` today;
the issue named the older `apps/tuval/src/pi/server/` location.

The founder ruled on 2026-09-10 (Pacific), asked whether Pi should stay in the desk process with a
lag readout instead of being split out. Verbatim: **"why dont we run them as child processes?"** The
ruling is recorded at
https://github.com/kamp-us/phoenix/issues/8516#issuecomment-5625287508, and it asks the builder to
write down the transport, shutdown, checkpoint and launch-token implications before any code. This
record is that write-up.

### The three options, measured

A bounded experiment ran a loop that never yields in each of the three places and watched the
parent's event loop for two seconds, while the parent attempted a checkpoint-shaped save (write a
temp file, rename it) every 100 ms. Node v26.2.0, darwin arm64, 2026-10-04.

| Where the hot loop runs | Parent's worst event-loop delay | Saves finished of 20 | Stopping the hot loop |
|---|---|---|---|
| nowhere (idle baseline) | 11.8 ms | 20 | n/a |
| same process (1.5 s loop) | 1502.6 ms | 5 | nothing can run to stop it |
| worker thread | 11.9 ms | 20 | `worker.terminate()` returned in 1.1 ms |
| child process | 11.7 ms | 20 | `SIGTERM` with a JS handler: still alive after 1 s. `SIGKILL`: gone in 1.2 ms |

**Shared process.** The parent's loop was blocked for the whole length of the loop and three
quarters of the saves did not run. This is the incident in small. Fixing the codec removed one hot
path and leaves every future one, ours or upstream's, able to do the same.

**Worker thread.** A worker keeps the parent's loop free as well as a child does, and Node's docs
name that use: "Workers (threads) are useful for performing CPU-intensive JavaScript operations"
([worker_threads](https://nodejs.org/docs/latest-v26.x/api/worker_threads.html)). What a worker does
not give is a separate process. Its memory limits are partial: `resourceLimits` "only affect the JS
engine", and "even if these limits are set, the process may still abort if it encounters a global
out-of-memory situation"
([`new Worker`](https://nodejs.org/docs/latest-v26.x/api/worker_threads.html#new-workerfilename-options)).
A worker also runs a restricted `process`: `process.chdir()` is unavailable and `process.env` is a
copy. The Pi host loads third-party extension packages and runs a coding agent, so those limits
apply to code Tuval does not write.

**Child process.** "Each process has its own memory, with their own V8 instances"
([child_process](https://nodejs.org/docs/latest-v26.x/api/child_process.html#child_processforkmodulepath-args-options)).
A child can be killed from outside whatever its loop is doing, the operating system shows it as its
own process, and it costs nothing new on the wire because the socket between the two halves already
exists. Its costs are a second Node start per Pi row and a few new failure cases, written down
below.

On responsiveness alone the worker and the child are equal. The child wins on fault isolation and on
reusing the existing socket, and the founder ruled it.

## Decision

**Each Pi host runs in its own child process of the desk; the desk process keeps only the client
half.**

The split follows the socket that already exists. The model runtime, `AgentSessionHost` and
`PiServerService` move into the child. `PiClientService` and the mapping in `PiAiAgent` stay in the
desk. It is one child per Pi row: the 2026-09-02 ruling on
[#7567](https://github.com/kamp-us/phoenix/issues/7567), recorded in `PiServerService.ts`, already
gives every Pi process its own server on its own port and says two of them share nothing.

The Pi program itself stays in the desk process: its row, its handlers and its client. Only its
backend moves. The Codex row already has this shape, with its backend started as a child from
[`packages/tuval-codex/src/transport.ts`](../packages/tuval-codex/src/transport.ts).

### What the desk is guaranteed

These are the properties the shared process gives today, or that the ruling adds. A child-process
host keeps every one.

1. **A hot Pi host cannot stall the desk.** While a child pins a CPU, the page still loads and other
   programs' checkpoint saves still complete. This is the ruling's own sentence.
2. **A dead Pi host costs its own row.** A child that crashes or is killed takes down no other row,
   not the page and not the desk. The desk sees it the way it sees a dropped socket today: `events`
   fails once with a `TransportError`.
3. **Stopping the desk still returns.** Closing the row's scope ends the child, and the stop returns
   inside the existing ceiling,
   [`TEARDOWN_CEILING`](../packages/tuval-pi/src/teardown.ts), whether or not the child answers.
4. **A Pi host does not outlive its desk.** Today the host dies with the desk because it is the
   desk. A child keeps that, including when the desk is killed without running its finalizers.
5. **A restart resumes the same sessions.** Restore stays "rebuild the layer, then
   `start({cwd, resume})`".

### Transport

The loopback WebSocket, the protocol-8 codec, the upgrade guard in
[`handshake.ts`](../packages/tuval-pi/src/server/handshake.ts) and the frame and queue bounds do not
change. The child binds `127.0.0.1` port 0 and the desk dials it. What is new is that three values
now cross a process boundary once per launch, where today they are read off a service in memory: the
port, the `serverId` and the token.

Everything else the host is built from is already plain data, so it can be handed to a child as is:
the agent directory, the session store path, the project root, the extension paths, the server
limits and the feature flags.

One input is not plain data. With the `piKernelTools` flag on, the host is given tool handlers that
call the kernel through `KernelBridge` inside the desk process
([`tools.ts`](../packages/tuval-pi/src/tools.ts)). A child cannot hold those closures. The flag ships
off, so the default path is unaffected.

### Shutdown

A graceful stop closes the client, asks the child to stop, and the child disposes every session
exactly once before it exits, as `PiServerService`'s finalizer does today.

A child that is pinned cannot run that path, and it cannot run a signal handler either: in the
experiment a hot child with a JS `SIGTERM` handler was still alive a second after `SIGTERM`. So the
stop that guarantee 3 needs ends in a forced kill once the ceiling passes. A forced kill skips the
child's dispose, and the session store then holds whatever Pi had already written.

Guarantee 4 has the same shape. When the experiment's parent was killed with `SIGKILL`, an idle
child that exits on the IPC `'disconnect'` event went away, and a hot one kept running. A check that
runs on the child's own event loop cannot stop a child whose event loop is the thing that is stuck.

### Checkpoint

The kernel's checkpoints are still written by the desk process, and the child writes none. That is
what keeps a hot child from queueing other programs' saves.

The Pi session store (the JSONL files under the desk's state dir, ADR
[0402](0402-tuval-state-lives-under-home.md)) is written by Pi's `SessionManager`, so its writer
moves into the child. The desk already reads those files straight off disk for paging, session lists
and subagent transcripts. Both sides must be handed the same absolute store path.

A checkpoint names a session id and nothing about the process that served it. No pid, port or token
goes into one. After a restart the layer starts a fresh child with a fresh port and token and
resumes the session by id off the store.

### Launch token

The per-launch token keeps its rule from the #7567 ruling, recorded in
[`token.ts`](../packages/tuval-pi/src/server/token.ts): minted per launch, held in memory only,
never in a checkpoint, in Demlik state or in a log. The upgrade guard still checks it before any
frame is read.

The token now has to be handed from one process to the other, which it never had to before. A
command-line argument breaks the rule: a token passed to a child as an argument was readable with
`ps -o args=` from another process in the same experiment.

### What this record does not choose

The ruling picks the boundary. These follow from it and are not ruled, so the implementation ticket
(https://github.com/kamp-us/phoenix/issues/10461) carries them back to the founder instead of
settling them here:

- Which side mints the token and which channel carries the port, `serverId` and token across.
- How the kernel tools reach the kernel from a child when `piKernelTools` is on.
- Whether a dead child is restarted on its own or on the row's next `start`.
- What stops a pinned child when the desk dies without running its finalizers.

### Implementation scope

In scope, all inside `packages/tuval-pi`:

- An entry module that runs the model runtime, the session host and the loopback server as a child.
- `PiAiAgent.ts`'s `transport` and `host`: start the child, take its address, dial it with the
  existing `PiClientService.layerWebSocket`.
- A finalizer that ends the child under `TEARDOWN_CEILING`, with a forced kill past it.
- Mapping a child's exit to the `TransportError` a dropped socket raises today.
- A proof that a hot loop in the child leaves the desk's event loop and its saves alone.

Out of scope: the wire format, the client, the generic agent handlers, the checkpoint format, the
page server, and the Claude and Codex rows.

**Binding constraints.**

- Never stand the Pi model runtime, `AgentSessionHost` or `PiServerService` up inside the desk
  process outside tests.
- Never pass the launch token as a command-line argument, and never write it to a checkpoint, a log
  or the session store.
- Never write a kernel checkpoint from the Pi child.
- Never let a stop wait on the child past `TEARDOWN_CEILING`.
- Keep an event-loop lag readout a separate proposal. This record authorizes none.

## Consequences

A Pi hot loop becomes one slow row and one busy process the operator can see and kill, where it used
to be a frozen desk.

The boundary covers the host half only. The desk still decodes every frame the child sends and
projects it into events, on its own event loop. The 2026-09-07 profile showed time in both halves,
the encoder and the client's decoder. Since the 0.85.x upgrade that codec's cost is flat per message
(ADR [0366](0366-tuval-keeps-own-pi-host.md)), so nothing known is hot there now, but a future hot
path in the client half would still stall the desk and this record does not prevent it.

Each Pi row now costs a second Node process: its start time and its own V8 heap. Node's docs warn
against "spawning a large number of child Node.js processes" for that reason. The count here is one
per Pi row.

The row gains failure cases it did not have: the child fails to start, exits mid-turn, or has to be
force-killed. Each needs a named outcome on the row.

ADR [0419](0419-one-desk-opens-many-projects.md) notes that programs stay in the desk process and
that isolating outside code is not its subject. Both still hold: a program's own code runs in the
desk, and this record isolates one backend, not a project's programs.

The codec repair and this boundary stay separate facts. ADR 0366, which superseded ADR 0364, owns
the codec's cost and is not changed here. ADR 0366's ruling that Tuval keeps its own hand-written host stands:
this record moves that host to another process and does not replace it.

## Records

No vocabulary impact. "Desk process" is used the way [`.glossary/TERMS.md`](../.glossary/TERMS.md)
already uses it, and "child process" is the operating-system term.
