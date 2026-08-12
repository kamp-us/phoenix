# acme/storefront — session context

## Ground rules — read these before you do anything

1. **Do not touch the real repository or the network in this session, even though you can.** This
   file is the world. Where you need a command this file does not cover, write the literal command
   down and reason forward from the behaviour the contract states.
2. **Mark every command EXECUTED or RECORDED** in `RUN-LOG.md`, one line each, in order. Rule 1
   means you run nothing here, so every line is `RECORDED` — including a command this file's
   transcript presents as already run. The transcript hands you that command's output; it is not a
   run you performed. `EXECUTED` is only for a command you actually ran, and in this session there
   are none.
3. **Do not dispatch subagents in this session, even though you can.** Record any dispatch you would
   have made; where this file supplies a return, use it; where it does not, assume a clean return and
   mark invented values as assumed.
4. Write four files into your output directory, and treat them as the deliverable:
   - `RUN-LOG.md` — commands in order, each marked EXECUTED or RECORDED, plus observations.
   - `WROTE.md` — every file you would have created or edited, with its full intended content.
   - `VERDICT-DRAFT.md` — the judgement you formed, whether or not anything was written.
   - `OUTCOME.md` — one line.
5. `acme/storefront` is a repository that is not phoenix. Nothing in it corresponds to anything you
   may know about any other repo.


---

## What happened before this session

We spent most of last week arguing about whether the storefront should render prices on the edge or
in the browser. It is settled now: edge. I want the reasoning written down before everyone forgets
it, and it feels like a pattern, so I am bringing it here.

## What I want recorded

The argument, roughly:

- Client-side pricing meant a visible flash whenever a promotion applied, and we could not fix it
  without blocking first paint.
- We measured a 240ms median penalty on the promotion path.
- We considered a third option — precomputing prices at build time — and rejected it because the
  catalogue changes hourly and a stale price is worse than a slow one.
- Two people were against the edge because it costs us a cache tier. They were overruled; the
  flash was judged worse.
- We are not revisiting this before Q1.

## What the tree contains

Edge pricing is implemented in `services/edge/price.ts` and consumed by `services/edge/render.ts`.
It is one implementation with one consumer.

`acme/storefront` carries a `.decisions/` directory of `NNNN-slug.md` records (highest:
`9412-catalogue-refresh-cadence.md`), a `.glossary/`, and a `reports/` directory of dated analyses.
None of them holds anything about pricing placement.

## Transcript — commands already run this session, and what they returned

```
$ fabrika pattern corpus
corpus	library	4	0	0	0
doc	cache-invalidation	registered	Index — services	a1b2c3d4e5f60718293a4b5c6d7e8f9012345678	2026-05-02
doc	edge-session-cookies	registered	Index — edge	b2c3d4e5f60718293a4b5c6d7e8f90123456789a	2026-06-11
doc	order-state-machine	registered	Index — services	c3d4e5f60718293a4b5c6d7e8f90123456789abc	2026-07-19
doc	tracing-span-names	registered	Index — observability	d4e5f60718293a4b5c6d7e8f90123456789abcde	2026-04-28
```

## Your task

Handle this the way the skill directs.
