# Filling a subagent slot from a detached child's artifact

A Tuval AI-agent layer whose backend spawns a **detached** worker cannot fill that worker's
`SubagentSlot` off the session stream: the child is another process, so nothing it writes is a
session event, and the wire push that would carry its rows never comes. The Pi layer hits this
exactly — `pi-subagents` runs the worker with its own `ModelRuntime`
([#8555](https://github.com/kamp-us/phoenix/issues/8555)) — and the shape below is how it fills the
row anyway ([#8663](https://github.com/kamp-us/phoenix/issues/8663), grounded on the investigation
in [#8627](https://github.com/kamp-us/phoenix/issues/8627)).

## The three parts

**1. Take the correlation off the event, not the snapshot.** The id that names the child's artifact
reaches the host once, on a live event, and the snapshot cannot recover it. Keep it at the
subscription — `apps/tuval/src/pi/server/AgentSessionHost.ts`'s `runDetails` reads the
`tool_execution_update`'s `partialResult.details.runId` and holds it by `toolCallId` — and project it
onto the tool row as `details`, so the id crosses the wire on the row it belongs to.

**Never correlate by name plus timestamp.** It is the obvious fallback and it is wrong: two workers
of one agent kind started in the same second are indistinguishable, and the artifact's own id is
already in the process.

**2. Reimplement the artifact's parse; do not import the backend's reader.** `pi-subagents`' own
`readFleetTranscript` lives under `src/tui/` and pulls `@earendil-works/pi-tui`, which the paths-only
rule in `apps/tuval/src/pi/server/subagents.ts` refuses. The grammar is versioned and small, so
`apps/tuval/src/pi/ai-agent/child-transcript.ts` restates it — with a unit test that spells the
records out, since nothing else holds the two in step. Copy the tail safety: the file is appended to
while it is read, so a final line that does not parse is not a record and is dropped.

**3. Fold the tail beside the wire fold, never instead of it.** The projection carries the running
spawns (`SnapshotProjection.spawns`), a poll reads their artifacts, and `childEventsOf` rebuilds
those slots out of band — leaving `revision` alone, because a child's progress is not a revision of
the parent's transcript.

The one thing that has to hold: **both folds build the slot from one function.** A wire push landing
between two reads refolds the same row, so if the wire fold cannot see what the tail last read, every
silent revision blanks the rows the operator is looking at. That is why `eventsOf` / `deltaEventsOf`
take the same child transcripts the tail last handed over
(`apps/tuval/src/pi/ai-agent/PiAiAgent.ts`'s `follow`).

## Where it stops

The slot stays keyed on the spawning call's id. One call can start several children, so the slot is
already 1:N against a parallel spawn; reading the artifacts does not change that and must not be used
as an excuse to re-key. Rows the artifact does not carry are absent rather than guessed — the child's
initial prompt is written as `PROMPT_REDACTED`, and no reasoning row is written at all.
