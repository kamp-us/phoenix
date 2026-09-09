# Codex as a Tuval agent

`apps/tuval/src/codex/` implements `TuvalAiAgent`. `codexSession` uses the same
`aiAgentProgram`, core, ports, history paging rules, chat window, inspector and session
list as the Pi and Claude programs. It adds no second UI or agent interface.

## Connection and ownership

`transport.ts` starts `codex app-server` over stdio through Effect's
`ChildProcessSpawner`. It initializes once, then reads JSONL responses and notifications
from one stdout stream. Request IDs match replies to Deferreds; server requests and
notifications go to one queue. A permission request cannot block the response reader.

A session owns a closeable Effect Scope. Replacing or closing the session closes that
scope, including its OS process, streams and local tool server. Disconnects and malformed
known messages fail the stream; they do not trigger an automatic reconnect. The failed
session is closed under its owning process scope and refuses further prompts. Pending RPC
requests and the event queue fail together in one uninterruptible cleanup. Completing a
Deferred can wake a competing timeout branch, so interrupting halfway through that cleanup
would leave an event subscriber waiting forever.

`prompt` returns after `turn/start` accepts the input, not after generation. The backend's
`turn/completed` ends the turn. A completion that arrives before the acceptance response
must not be overwritten by that response. Prompt keys are remembered for the current
session; a confirmed refusal releases a key, while an uncertain send does not.

## Tools and permissions

`ai-agent/tools/KernelBridge.ts` is shared by Claude and Codex. The former Claude paths
re-export it so existing consumers keep their imports. The bridge still calls only the
existing process spawn/send/read spells, under the row's configured scope.

Codex receives the three tools through an HTTP MCP server bound to `127.0.0.1` on an
assigned port. Every request needs a random bearer token, and requests with an Origin
header are rejected. The token and URL travel in thread configuration, not process
arguments, browser state or a user config file. Each HTTP request owns a stateless MCP
transport. Closing the session interrupts its tool fibers and closes the listener.

HTTP MCP is used rather than `dynamicTools`: the latter can only be supplied on
`thread/start`, while an HTTP MCP override also works when resuming a session originally
created in the terminal. Both start and resume mark this tool server as required.

The row offers `read-only` and `workspace-write`. Both keep `approvalPolicy: "on-request"`
and request the user as the approval reviewer. Full-access and never-ask modes are not
configurable here. Start checks the returned sandbox and approval policy rather than
announcing the requested values blindly. Permission cards offer one-time approval or
denial, not permanent grants. Permission-grant requests use turn scope. A card clears on
`serverRequest/resolved` or turn teardown, not merely when its answer enters stdin.
Cards are keyed by stable item IDs, not connection-local RPC IDs. Multiple approvals
for one item are queued and shown one at a time. On resume, IDs read from backend history
resolve stale checkpointed cards as denied before new requests are read.
Unknown server requests receive an explicit protocol refusal and a visible failure.
Tuval does not pretend its permission buttons can answer arbitrary forms.

## History and controls

`store.ts` reads Codex's store, never a Tuval copy. It enumerates both active and archived
threads, all source kinds and all providers. History uses `thread/read` with
`includeTurns: true`, mapped before applying the existing whole-turn `planTranscriptPage` rule. Missing turn timestamps fall back to
thread creation time. `sessionTranscript` opens only a scoped store connection: no
thread start, resume, or tool server. Missing sessions, unreadable stores and unknown
cursors remain distinct errors.

A picker resume replays all history. A checkpoint resume compares backend rows with the
held tail, replaying changed rows and anything after its newest known ID. Clock fallback
changes alone do not count as changed content.

New threads explicitly request `historyMode: "legacy"`. The
[0.153.4 history investigation](../reports/2026-09-09-codex-history-8464.md) found paginated
history conditionally supported rather than uniformly refused: nonempty legacy history and
*projected* paginated history both read back in full, with the paginated item IDs the rollout
carries, while a paginated thread whose metadata row is missing refuses the read outright.
Generated types are still not proof that a runtime method works. An existing unreadable
thread remains an error. A known fresh session returns empty history until its first accepted
turn, because Codex does not materialize a durable legacy thread before its first user message.

**An empty paginated read is refused, not believed.** The same investigation read a known
nonempty paginated rollout that Codex had not projected yet: `thread/read(includeTurns: true)`
answered success with `turns: []`, and turn and item paging answered empty with null cursors,
until an explicit resume projected it. So a successful empty answer and an exhausted cursor are
both compatible with history the store simply has not built, and nothing else in the read-only
protocol tells the two apart — the preview is evidence neither way, since a blank one is normal
and a nonempty one only restates the contradiction. `readHistory` therefore trusts a zero-turn
answer only under `historyMode: "legacy"`, whose loader replays the rollout directly; a
paginated, absent or unrecognized mode fails as an unreadable store, carrying the session ID
and the reason. This is fail-closed and deliberately conservative: a stored paginated session
that really is empty is refused too, and Tuval says it could not verify the emptiness rather
than claiming the session is empty. It detects no missing projection as such, recovers no
data, and explains nothing about Codex's internal materialization. Read-only lookup still
never starts, resumes or attaches anything to warm that history. The guard is shared, so the
same refusal reaches `page` and explicit-resume replay; the known-fresh active session's empty
page is unaffected, because that path answers before it reads the store at all.

Known item types are decoded at the boundary. Unknown item kinds become bounded system
rows instead of disappearing. Live reply updates reuse the item's ID and are optional,
controlled by `streamPartialReplies`, off by default. Tool result text uses the shared
8 KB bound.

Models come from `model/list`; model, thinking and mode changes use
`thread/settings/update`. Offered thinking levels are the intersection of the model's
catalog and Tuval's vocabulary, with no renaming. `ultra` was added to that shared
vocabulary and composer because the tested Codex catalog offers it; Pi still validates
against its own protocol schema. App-server offers no terminal slash-command catalog,
so `commands` is empty. `TurnUsage` converts running thread totals into one complete
report at turn completion, because the shared usage ledger accepts a turn only once.
The first observed update uses its `last` counts rather than charging all prior thread
usage to a resumed turn. App-server supplies no dollar cost, so this implementation
records zero rather than estimating one.

## Native child agents

`subagents.ts` maps `collabAgentToolCall` into whole `AgentEvent` subagent-slot
upserts. A slot is keyed by the spawning call, never by a later wait/send call.
The internal child-thread map correlates subsequent notifications and reads; child
item IDs are namespaced under that spawning call and carry its `parentId`.
Replacing an item preserves its original timestamp and position. Stored snapshots
restore the backend's ordering rather than appending another copy of each row;
notification-only rows not yet in that read follow it.

Child items have a source-precedence policy, not a guessed delta offset. Until the
first snapshot of an item, its live accumulator owns partial updates. Hydration retires
that accumulator: queued starts cannot replace the snapshot, and deltas for snapshot-owned
items request another read of that child rather than appending possibly overlapping bytes.
This also advances rows first discovered by a snapshot. `item/completed` carries the
final item (the versioned app-server README, Events / Items) and takes precedence over
subsequent polls, starts and deltas. Turn completion reads the child once more, then
finalizes the reconciled slot rows, never a retired accumulator. A successful completion
clears partial markers without marking replies interrupted. This policy does not infer
sequence numbers the protocol does not supply; snapshot-owned progress depends on reads,
and a read refusal follows the visible failure path below.

A completed spawn call does not imply a completed child. `agentsStates` supplies
pending/running/completed/interrupted/errored/shutdown/notFound outcomes; `subAgentActivity`
updates known children. Child token notifications supply counts, never estimates.
Where no child usage notification was received, zero means unreported, not measured
zero spend; history does not supply a usage total. Finished slots retain their
transcripts for the existing navigator and back action. Nothing changes the shared
agent interface: like Claude, Codex has an extra backend `subagentTranscript` member;
the generic window consumes `SubagentSlot.items`, not that undeclared service method.

`child-store.ts` uses only `thread/read(includeTurns: true)`, validating both the
returned child ID and its `source.subagent.thread_spawn.parent_thread_id`. The active
session polls running children once per second, under the same semaphore as the
message mapper. This serves progress even when the connection has no child event
subscription. No child is started or resumed by that read. Restore recovers spawning
calls from parent history and reads each correlated child's stored transcript.
A background child observed active is re-announced after the parent's ready event,
which otherwise settles slots in the shared core. Interrupt requests address known
active child turns as well as the parent. A parent refusal emits the shared
`tuval/ai-agent/InterruptError` failure: `turn-running` preserves the running turn in the
core, while `no-live-turn` lets it settle. The adapter chooses the reason from its turn
state when the refusal arrives, not when the request was sent (ADR
[0356](../.decisions/0356-tuval-interrupt-refusal-as-failure-tag.md)). Child refusals remain
visible in the slot's last line, without changing its arrival-time status, items or
observation membership. A delayed refusal cannot revive a child that finished while the
interrupt request was pending. Parent interruption, unrecoverable failure and connection
teardown detach all currently known spawning slots, including already finished slots and
spawns awaiting a child ID, and retain their last rows. Detached slots ignore subsequent
child notifications, activity/collab state updates and read results; polling skips them.
The refusal notice can still update a detached slot's last line. Successful parent completion
does not detach background children. Ending observation is not proof that an external worker
was killed.

Missing, unreadable, malformed and unsupported reads are distinct typed refusals,
not empty transcripts. A live slot displays the refusal as a system row and finishes
observation on it. The versioned pre-first-message unmaterialized refusal is retryable
while the native lifecycle still reports running; its error remains visible until a
successful read replaces it. Unknown activity without a spawning call is a visible
unsupported notice. Multiple children from one spawn are refused because the shared
slot contract is one spawning call per worker. Descendant spawns inside a child's
transcript remain tool rows; recursive descendant navigation is not implemented.
Ephemeral histories and unprojected paginated histories remain explicit refusals,
including the fail-closed empty-read limitation above. These are not claims of full
native runtime parity.

## Source and checks

The protocol was checked against **codex-cli 0.153.4**, including the output of
`codex app-server generate-ts --experimental`. The projections in `protocol.ts` decode only
the fields this implementation consumes.

- [Codex 0.153.4 app-server README](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md): Protocol, Initialization, thread start/resume/read/list, settings update, Approvals and Dynamic tools.
- [Codex thread reader](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/thread_processor.rs): `read_thread_view`, `load_live_thread_view`, `thread_read_live_history_error` and `unsupported_thread_store_operation` establish read-only live/stored hydration and the refusal strings.
- [Codex thread-read tests](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/tests/suite/v2/thread_read.rs): loaded history, unmaterialized refusal and unsupported pagination.
- Installed 0.153.4 generated `ThreadItem`, `CollabAgentTool`, `CollabAgentState`, `CollabAgentStatus`, `SubAgentActivityKind`, `Thread`, `SessionSource` and `SubAgentSource` define the native projections. The generated bindings were inspected without starting a model turn.
- [Codex MCP configuration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/mcp_types.rs): required servers, HTTP transport and `http_headers`.
- [Effect LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md): Writing Effect services, Managing resources and Working with child processes.
- [Effect child-process example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/60_child-process/10_working-with-child-processes.ts): `ChildProcessSpawner`, stream consumption and `NodeServices.layer`. The implementation was typechecked against Tuval's installed Effect rc.112.
- MCP SDK 1.30.0, `server/streamableHttp` and `server/webStandardStreamableHttp`: stateless transports and JSON responses; exercised through the SDK's real client in `tools.integration.test.ts`.

`agent.unit.test.ts` substitutes the connection and tool listener. The transport and MCP
integration tests use real local OS processes and sockets, without generation.
`codex-cli.integration.test.ts` is opt-in via `TUVAL_CODEX_PROTOCOL_TEST=1`; it uses an
isolated `CODEX_HOME`, runs the installed CLI and makes no model turn. It checks opening,
settings, kernel tool calls, listing and a fresh empty session through `TuvalAiAgent`.
`subagents.unit.test.ts` scripts spawn begin/end, child item replacement and ordering,
wait outcomes, token updates, polling, background retention, interruption, parent errors,
checkpoint restore, isolation and typed read refusals. Interleaving fixtures hold a poll
open over queued deltas, advance snapshot-only rows and finish on a newer read, for both
successful and interrupted turns. Completed payloads remain final across later polls.
Delayed child-interrupt refusal fixtures cover running children, successful/interrupted child
completion, successful/interrupted/failed parent completion and unrecoverable parent errors.
They fold adapter events through the shared core and check retained content, unchanged terminal
state and no restarted reads, including late child and parent-carried lifecycle notifications
following teardown. A mapper fixture also rejects late hydration after detaching already
finished and pending-spawn slots.
`agent.unit.test.ts` delays a refused interrupt until before or after turn completion and
folds both failures through the generic core. The shared ChatWindow test also navigates
into a native-mapped slot, hydrates it over queued text, completes it and returns to the
parent without losing the reconciled text. These
fixtures are authored against the versioned protocol, not captured model output.
Paid generation, actual model-produced approval requests and nonempty real session history
and resume still need an operator run; deterministic fixtures do not prove those paths
against the CLI.
