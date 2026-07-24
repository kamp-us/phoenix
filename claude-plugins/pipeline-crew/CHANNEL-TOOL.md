# The crew channel tools — their allowlist tokens, and the boot-window wait

Every crew role coordinates over the crew channel MCP server (`@kampus/pipeline-crew-mcp`, wired
per session via `--channels server:@kampus/pipeline-crew-mcp`), which serves the send tool
`channel_send`, the discovery tool `channel_kinds`, and — for the engine — the claim tool
`channel_claim`. **This doc is the single source for two things a role needs to actually call
them**: the exact allowlist token each `tools:` frontmatter must carry, and how to behave in the
brief window right after boot before the channel has connected. The four crew defs cite this; they
never re-derive it inline.

## The allowlist token — `mcp___kampus_pipeline-crew-mcp__channel_send`

A crew session boots as a top-level `claude --agent crew-<role>` session, so the role's
agent-def `tools:` allowlist is the hard gate on what the model can call. A connected MCP
server whose tool is **absent from that allowlist is present-but-uncallable** — `/mcp` shows
the server up with `channel_send`, yet the model's toolset does not include it, so the role
cannot coordinate. That omission — not boot timing — was the live cutover failure: a role
tasked to dispatch found the tool missing and burned budget reverse-engineering its own
channel (#3483, the root cause of the #3482 symptom).

So each crew def's `tools:` allowlist **must list the channel tool by its full MCP token**:

```
mcp___kampus_pipeline-crew-mcp__channel_send
```

That token is not a guess — it is how claude-code derives an MCP tool's callable name:
`mcp__` + the server name sanitized by `replace(/[^a-zA-Z0-9_-]/g, "_")` + `__` + the tool
name. For the server `@kampus/pipeline-crew-mcp` the `@` and `/` sanitize to `_`
(`_kampus_pipeline-crew-mcp`, hyphens preserved), and the leading `_` is what makes the
`mcp__` + `_kampus…` join a **triple** underscore. Grounded against the claude-code 2.1.214
tool-name builder and confirmed against the live `/mcp` tool name — a wrong string
silently fails closed and re-blocks cutover, so it is copied exactly, never approximated.

## The discovery tool — `channel_kinds` (resolve a payload shape before sending)

Every role that sends **also** carries the discovery tool, `channel_kinds` — the token derived the
same way:

```
mcp___kampus_pipeline-crew-mcp__channel_kinds
```

`channel_kinds` takes **no arguments** and returns the whole channel contract: every message kind's
payload as a JSON Schema, plus each role's sanctioned send/receive seams. A sender reads a kind's
shape from it **before the first `channel_send` of that kind**, so it builds a valid `body` up front
instead of discovering the shape from a send-time reject. That reject path is real and lossy:
`channel_send` decode-checks `body` against the kind's schema (#3229), and a seat that booted with
no inbound example to copy otherwise blind-guesses the shape and burns retries on rejected sends —
the exact failure this tool exists to prevent (#3622/#3761). Because it is served on the same
`McpServer` as `channel_send`, its allowlist token is required for the same reason: absent from a
def's `tools:`, the tool is present-but-uncallable and the discovery step is impossible. Every
sending seat lists it — the three bridges and the engine alike.

## The engine's second tool — `channel_claim` (resource deconfliction)

The **engineering-manager** (the one engine role) additionally carries a second channel tool,
`channel_claim` — the token derived the same way:

```
mcp___kampus_pipeline-crew-mcp__channel_claim
```

`channel_send` and `channel_claim` are **different mechanisms, not variants**: `channel_send`
relays a typed message to a peer's inbox (coordination), while `channel_claim` invokes the
tracker's resource-keyed `Claim` and returns a `{granted, collision, owner}` reply — a real
cross-engine lock. An engine calls `channel_claim {resource: "<issue>"}` **before it opens a
lane**: `granted` ⇒ it holds the lane, `collision` ⇒ another engine holds it (back off). Sending
a `Claim`-shaped message via `channel_send` does **not** lock anything — it just delivers a
message to an inbox — which is why the claim needs its own tool (#3509). Only the engine carries
it; the bridges (chief-of-staff, cartographer, intake-desk) claim nothing, so they carry
`channel_send` + `channel_kinds` but not `channel_claim`.

## The boot window — wait and re-check, never diagnose infra

Even with the token in place, the crew server does not advertise `channel_send` the instant a
session becomes interactive: the server only serves the tool once it has claimed its peer slot
on the tracker (the claim-before-serve ordering, #3481), and on cutover — when many panes boot
at once — that claim can lag a moment behind the session becoming taskable. A role tasked
inside that window will briefly not see `channel_send` in its toolset.

**If you need `channel_send` for a task and it isn't in your toolset yet, WAIT briefly and
re-check — do not investigate infra or read crew-mcp source.** The channel connects on its own
with no intervention (steady state: an idle role's channel is long up before work arrives).
The flailing — reading `channel-server.ts`, running the session binary by hand — is exactly the
~44k-token burn this guard exists to prevent (#3482). Give the connect a moment, look again,
then proceed.

**The wait is bounded, and a still-empty toolset is a REPORT, not a longer wait.** A permanent
failure looks identical to the boot window from a seat, so waiting patiently on one burns a whole
session silently — that is exactly what #3753 did (one spec-invalid tool `inputSchema` made the
CLI discard the server's entire `tools/list`, so no seat ever saw any channel tool). If the tools
are still absent after a re-check or two, stop waiting and **file it** (the `report` skill) —
still without diagnosing infra yourself.
