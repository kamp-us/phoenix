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

Three checkout services were rewritten last quarter. Something about how they build idempotency keys
kept catching my eye while I read them.

## The shape, as it appears in the tree

`services/checkout/charge.ts`:

```ts
const key = idempotencyKey(order.id, attempt, PAYMENTS_EPOCH);
await payments.charge({...body, idempotencyKey: key});
```

`services/refunds/issue.ts`:

```ts
const key = idempotencyKey(refund.orderId, attempt, PAYMENTS_EPOCH);
await payments.refund({...body, idempotencyKey: key});
```

`services/subscriptions/renew.ts` does the same with `sub.orderId`.

`packages/payments/idempotency.ts` defines it:

```ts
// PAYMENTS_EPOCH is bumped only when the upstream account is re-keyed. Including it means a
// replayed webhook from before a re-key cannot collide with a live attempt.
export const idempotencyKey = (id: string, attempt: number, epoch: string) =>
  sha256(`${epoch}:${id}:${attempt}`).slice(0, 32);
```

`packages/payments/idempotency.test.ts` has a case named
`"a pre-re-key replay does not collide with a live attempt"`.

Git history shows `charge.ts` used `sha256(id + attempt)` in its first draft.

## Transcript — commands already run this session, and what they returned

```
$ fabrika pattern corpus
corpus	library	4	0	0	0
doc	cache-invalidation	registered	Index — services	a1b2c3d4e5f60718293a4b5c6d7e8f9012345678	2026-05-02
doc	edge-session-cookies	registered	Index — edge	b2c3d4e5f60718293a4b5c6d7e8f90123456789a	2026-06-11
doc	order-state-machine	registered	Index — services	c3d4e5f60718293a4b5c6d7e8f90123456789abc	2026-07-19
doc	tracing-span-names	registered	Index — observability	d4e5f60718293a4b5c6d7e8f90123456789abcde	2026-04-28
```

`.patterns/index.md` carries sections `Index — services`, `Index — edge` and
`Index — observability`, and its "When to add a new pattern doc here" section is the standard one.

## Your task

Handle this the way the skill directs.
