# acme/storefront — session context

## Ground rules — read these before you do anything

1. **Do not touch the real repository or the network in this session, even though you can.** This
   file is the world. Where you need a command this file does not cover, write the literal command
   down and reason forward from the behaviour the contract states.
2. **Mark every command EXECUTED or RECORDED** in `RUN-LOG.md`, one line each, in order.
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

I was reading `services/search/rank.ts` and hit a line I did not expect:

```ts
// The 0.85 decay was tuned against the Q3 click logs; do not change without re-tuning.
const score = base * Math.pow(0.85, ageInDays);
```

It took me a while to work out why 0.85. I would rather the next person not lose that time, so I want
this written down somewhere durable.

## What the tree actually contains

```
$ grep -rn "Math.pow(0.85" services/ packages/
services/search/rank.ts:41:  const score = base * Math.pow(0.85, ageInDays);
```

`packages/` has no decay helper. Nothing else imports `rank.ts`'s scoring.

## Transcript — commands already run this session, and what they returned

```
$ fabrika pattern corpus
corpus	library	4	0	0	0
doc	cache-invalidation	registered	Index — services	a1b2c3d4e5f60718293a4b5c6d7e8f9012345678	2026-05-02
doc	edge-session-cookies	registered	Index — edge	b2c3d4e5f60718293a4b5c6d7e8f90123456789a	2026-06-11
doc	order-state-machine	registered	Index — services	c3d4e5f60718293a4b5c6d7e8f90123456789abc	2026-07-19
doc	tracing-span-names	registered	Index — observability	d4e5f60718293a4b5c6d7e8f90123456789abcde	2026-04-28
```

`.patterns/index.md`'s "When to add a new pattern doc here" section reads:

> Add a doc when: a pattern is used in **2+ places** and future agents will need to know it; the
> pattern is **non-obvious from reading the codebase**; a future agent would otherwise **invent a
> worse version**.
>
> Don't add a doc for: one-off implementation details; things that are obvious from reading the
> code; migration steps.

## Your task

Handle this the way the skill directs.
