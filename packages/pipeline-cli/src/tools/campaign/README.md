# campaign — the fail-closed founder-approval-trace verifier

`pipeline-cli campaign verify-trace <wave-label> [--founder <login>]`

The campaign skill is **invoker-agnostic** — a human *or* an agent may run it — so there is no
human-at-keyboard guard like `release`'s. The sole authorization that a wave-labeled cluster may
become a campaign is a durable, auditable **founder-approval trace** bound to the wave label, and
this verifier **fails closed** without it: neither an agent nor a human can conjure a campaign the
founder never approved (issue #2658).

## The founder-approval trace shape

A campaign is authorized only by a **founder-authored comment** — on any issue carrying the wave
label — whose **first line** is:

```
campaign-approve: <wave-label> · <ISO-8601-UTC>
```

- **`<wave-label>`** must equal the wave label under verification. This binds the approval to
  *this* cluster, so a valid approval of one wave never authorizes another.
- **`<ISO-8601-UTC>`** must be a valid ISO-8601 UTC instant (a `Z` suffix). It records *when*
  approval was granted, making the trace auditable after the fact.
- **author** must be the **founder**. The founder identity is injected as config
  (`--founder`, else `$CAMPAIGN_FOUNDER_LOGIN`) — never hardcoded, so no named identity lives in a
  committed artifact and the trust anchor stays configurable.

The marker is emphasis-tolerant (a leading `**`), case-insensitive on the keyword, and anchored to
line one — a comment that merely *quotes* the marker mid-body never counts (the same line-one
anchoring the `verdict` and `claim` markers use).

The shape is grounded in the **gated-audit-wave play**, where audit findings are returned to the
founder for approval *before* anything is filed; this verifier is the checkable seam that pins that
approval as a machine-verifiable artifact.

## Exit contract

Exit `0` **only** on a present, well-formed, founder-authored, wave-bound trace. Every other input
fails closed (non-zero, ADR 0092):

| Failure | Cause |
| --- | --- |
| `zero-scope` | empty wave label, no founder identity configured, or the label names zero issues |
| `absent` | the cluster is non-empty but carries no `campaign-approve:` marker |
| `malformed` | a marker exists but is malformed or bound to a different wave |
| `non-founder-author` | a well-formed, wave-bound marker exists but no author is the founder |

## Shape

The readme-guard idiom: a pure, IO-free, unit-tested core (`campaign-trace.ts`) that owns the
marker grammar and the default-deny decision, plus a thin `gh api` boundary (`github.ts`) that
gathers the wave-labeled cluster and its comments. The core is tested exhaustively over fixtures
without spawning `gh` (`campaign-trace.unit.test.ts`).
