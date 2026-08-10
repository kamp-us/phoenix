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

A build failed against `.patterns/order-state-machine.md`. I have not looked into why.

## The doc as it stands, in full

````markdown
# Order state machine

Orders move through `pending -> confirmed -> fulfilled`, and the only transition out of `pending` is
`confirm()`. Nothing else may write `order.status`.

## The transitions

`services/orders/state.ts` owns every transition, and `services/orders/state.test.ts` pins each one.
The shared helper lives in `packages/order-kit/src/transition.ts`, which we do not reimplement.
A caller asks for a transition and the module decides:

```ts
export const confirm = (order: Order) => transition(order, "pending", "confirmed");
```

Any other module that needs a status change calls into this one. That is the whole rule: one writer,
one file.
````

## What `services/orders/state.ts` contains today

```ts
export const confirm = (order: Order) => transition(order, "pending", "confirmed");

// Added when payment holds started expiring server-side.
export const expire = (order: Order) => transition(order, "pending", "expired");

// Added for the fraud queue: a pending order can be pulled out for manual review.
export const hold = (order: Order) => transition(order, "pending", "on_hold");
```

`services/orders/state.test.ts` has cases for all three, including
`"an expired order cannot be confirmed"`.

## Transcript — commands already run this session, and what they returned

```
$ fabrika pattern drift order-state-machine
drift	drifted	c3d4e5f60718293a4b5c6d7e8f90123456789abc	3	2	1	1
path	services/orders/state.ts	4	9f8e7d6c5b4a39281706f5e4d3c2b1a098765432	2026-08-04
```

The stderr scope line named one unresolved candidate: `packages/order-kit/src/transition.ts`.

## Your task

Handle this the way the skill directs.
