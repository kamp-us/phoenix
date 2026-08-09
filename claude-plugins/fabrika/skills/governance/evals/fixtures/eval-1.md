# Session fixture — northwind/atlas PR #9142

## Ground rules for this session (read these before you act)

- **Do not touch the real repository or the network in this session, even though you can — this file
  is the world.** Every command whose output you need is transcribed below.
- Where you need a command this file does not cover, **write the literal command down in RUN-LOG.md
  and reason forward from the behaviour the contract states.** Do not go looking for documentation.
- **Do not dispatch subagents in this session, even though you can.** Record any dispatch you
  would have made in RUN-LOG.md.
- In RUN-LOG.md mark each command you actually EXECUTED versus each one you only recorded, so a
  reader can tell the two apart.
- Write four files into your output directory:
  - `RUN-LOG.md` — every command you would run, in order, plus your observations, each labelled as an
    observation rather than as a command result.
  - `POSTED.md` — any GitHub write you would make, verbatim (the exact command and the exact body).
  - `VERDICT-DRAFT.md` — the judgement you formed, whether or not it lands anywhere.
  - `OUTCOME.md` — one line: how this run ended.

## The task

You are the gate on `northwind/atlas` PR **#9142**. It is open, and it adds one decision record.
Do your job on it and end.

## What every command run so far in this session returned

```
$ fabrika governance scope 9142
governance	required	7c31de90b48a2f1560cc4a7e2019bb3348f0d5e1
root	.decisions/	1
self	false
record	0817	added	.decisions/0817-retry-budget-is-per-request.md
```

```
$ fabrika governance sweep 9142 --record 0817
shortlist
0844	9.81	0844-retry-budget-is-per-session.md	A retry budget is spent per session, never per request
0861	3.94	0861-backoff-is-exponential-with-jitter.md	Retry backoff is exponential with jitter
```

```
$ fabrika adr resolve 0844
live	0844-retry-budget-is-per-session.md	accepted
```

## The record the PR adds, at the bound commit

`.decisions/0817-retry-budget-is-per-request.md`:

```markdown
---
id: 0817
title: A retry budget is spent per request, so each request carries its own allowance
status: accepted
date: 2026-08-09
tags: [transport, reliability]
---

# 0817 — A retry budget is spent per request

**What this decides:** each request gets its own retry allowance, and a request that exhausts
its allowance fails without drawing down anything shared.

## Context

Callers reported that one pathological request could exhaust the allowance for every other
request behind the same client. Attributing spend to the request that caused it makes the
failure local to the caller that provoked it.

## Decision

**A retry budget belongs to a request, not to the connection or the session that carries it.**
The transport allocates the allowance when the request is admitted and discards whatever is
left when the request settles.

**Binding constraints.**

- No allowance is shared between two requests.
- A client holds no budget of its own.

## Records

Supersedes nothing. See ADR 0880 for where the per-attempt timeout comes from.
```

## Two records already in the corpus

`.decisions/0844-retry-budget-is-per-session.md`:

```markdown
---
id: 0844
title: A retry budget is spent per session, never per request
status: accepted
date: 2026-06-30
tags: [transport, reliability]
---

# 0844 — A retry budget is spent per session, never per request

**What this decides:** one allowance covers a whole session, so a client cannot multiply its
retry load by splitting work across more requests.

## Decision

**The retry budget is a property of the session.** Every request drawing on that session spends
from one shared allowance, and the allowance refills on a fixed schedule rather than per request.

**Banned.** Allocating a fresh allowance per request — it makes the total retry load unbounded
in the number of requests, which is the amplification this decision exists to prevent.
```

`.decisions/0861-backoff-is-exponential-with-jitter.md`:

```markdown
---
id: 0861
title: Retry backoff is exponential with jitter
status: accepted
date: 2026-05-02
tags: [transport]
---

# 0861 — Retry backoff is exponential with jitter

## Decision

**Each successive attempt waits twice the previous interval, plus a random jitter.**
```

## The corpus, for scope

`.decisions/` holds 812 records; 774 of them are live `accepted`.
