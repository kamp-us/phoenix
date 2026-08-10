# The crew channel tools — their MCP tokens, and the boot-window wait

Every crew role coordinates over the crew channel MCP server (`@kampus/pipeline-crew-mcp`, wired
per session via `--channels server:@kampus/pipeline-crew-mcp`), which serves the send tool
`channel_send`, the discovery tool `channel_kinds`, and — for the engine — the claim tool
`channel_claim`. **This doc is the single source for two things a role needs to actually call
them**: the exact MCP token each tool appears under (and which a def that declares a `tools:`
allowlist must spell exactly), and how to behave in the brief window right after boot before the
channel has connected. The four crew defs cite this; they never re-derive it inline.

## The token — `mcp___kampus_pipeline-crew-mcp__channel_send`

A crew session boots as a top-level `claude --agent crew-<role>` session. **The four launched
seats declare no `tools:` key**, so the CLI grants each of them its full default toolset and the
crew server's tools arrive with it — no allowlist stands between a seat and `channel_send` (the
founder ruling on [#5253](https://github.com/kamp-us/phoenix/issues/5253) /
[#5260](https://github.com/kamp-us/phoenix/issues/5260)). Where a def *does* declare a `tools:`
allowlist — today only the `crew-investigator` subagent def, which is not a launched seat — that
allowlist is a hard gate: a connected MCP server whose tool is **absent from it is
present-but-uncallable**, `/mcp` shows the server up with `channel_send` while the model's
toolset does not include it, and the role cannot coordinate. That omission — not boot timing —
was the live cutover failure: a role tasked to dispatch found the tool missing and burned budget
reverse-engineering its own channel (#3483, the root cause of the #3482 symptom).

**What keeps #3483 shut now.** For a keyless seat the omission is impossible by construction:
there is no allowlist for the token to be missing from. What is *also* gone is the launcher's
pre-boot check on these seats — `missingSeatChannelTools` returns `[]` for a no-key (`inherit`)
def by construction (`packages/pipeline-crew-mcp/src/standup/toolset-assert.ts`), so stand-up
does not assert anything about the four seats' channel tools; it declines to look. Say it
plainly: the *class* of failure #3483 named cannot recur, but the launch-time assertion that
covered it is not doing the work — the remaining way a seat boots without the tools is
server-side (the server serving no `tools/list` at all, #3753), and that is caught at runtime by
the boot-window rule below, not before launch. Any def that **re-adds** a `tools:` allowlist
re-opens the omission path and **must** list the tokens below:

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

Every role that sends **also** gets the discovery tool, `channel_kinds` — the token derived the
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
the exact failure this tool exists to prevent (#3622/#3761). It is served on the same `McpServer`
as `channel_send`, so it reaches a seat the same way: the four keyless seats inherit it, and any
def that declares a `tools:` allowlist must name it there for the same reason `channel_send` is
named — absent from a declared allowlist, the tool is present-but-uncallable and the discovery
step is impossible. Every sending seat gets it — the three bridges and the engine alike.

## The engine's second tool — `channel_claim` (resource deconfliction)

The **engineering-manager** (the one engine role) additionally *uses* a second channel tool,
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
message to an inbox — which is why the claim needs its own tool (#3509). Claiming is the engine's
job alone; the bridges (chief-of-staff, cartographer, intake-desk) claim nothing. That split is
now a **charter rule, not a frontmatter fact**: the four seats are keyless, so all four are
*granted* `channel_claim` and only the engine's def tells it to call one. A def that declares an
allowlist expresses the split the old way, by listing or omitting the token.

## What the launcher asserts before a seat boots — and the one gap it cannot close

Stand-up refuses to launch a seat whose **declared** toolset and the crew server disagree
(`packages/pipeline-crew-mcp/src/standup/toolset-assert.ts`). For a def that declares a `tools:`
allowlist, a seat's post-connect granted set is exactly **declared ∩ served**, and both sides are
known before launch, so the runtime outcome is settled with zero panes up instead of mid-drain by
a rejected send (#4002):

- a token for **this** server naming a tool it does not serve (a typo, a renamed or removed tool) is
  refused — no connect window can produce a name that will never be on a `tools/list`;
- a def that **omits** `channel_send` or `channel_kinds` is refused — those two are mandatory for
  any def that declares an allowlist, so the pair can never go silently missing from one again;
- a token for **another** MCP server stays exempt: its toolset is unknowable here.

**These asserts do not apply to the four launched seats, because none of them declares an
allowlist.** `parseDeclaredToolset` reads a no-`tools:`-key def as `inherit`, and both
`resolveDeclaredToolset` and `missingSeatChannelTools` return empty for `inherit` by
construction — there is nothing declared to intersect or to find missing. So an `inherit` seat's
launch is not *asserted safe*; it is *not asserted at all*. That is the honest trade of the #5253
ruling: the allowlist-omission failure (#3483) is structurally impossible without an allowlist,
and in exchange the launch-time check that used to cover it is silent for these seats. A
server-side failure (#3753) therefore surfaces only after boot, via the boot-window rule below.

**The gap this does not close, stated plainly.** A live session's grant is fixed at ITS boot, from the
def as it stood THEN, and a seat has no way to read its own granted toolset back. So editing a def
under a running crew changes nothing for that crew, and the skew is invisible from inside it — the
seat sees the new def on disk while holding the old grant. The remedy is a re-stand-up, not a wait:
that is what re-runs the assert against the defs the seats will actually boot from.

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
