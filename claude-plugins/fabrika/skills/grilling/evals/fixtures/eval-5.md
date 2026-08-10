## Ground rules — read these before you do anything else

- **Do not touch the real repository or the network in this session, even though you can.** This
  file is the world. Everything you need about `acme/storefront` is below.
- **Do not dispatch subagents in this session, even though you can.** Record each dispatch you
  *would* make in `RUN-LOG.md`. Where this file supplies its return, use it; where it does not,
  assume a clean return and mark every invented value as assumed.
- Where you need a command this file does not cover, **write the literal command down** in
  `RUN-LOG.md` and reason forward from the behaviour the contract states.
- **Never execute a `fabrika grill …` verb, whether or not it resolves.** Record the literal
  command you would run and reason forward from the behaviour the contract states. Whether the
  binary answers is irrelevant — the prohibition stands either way, and a command that *does*
  resolve would act on a real repository rather than on this fixture.
- **For every command, mark whether you EXECUTED it or only RECORDED it.**

Write exactly four files into your output directory:

| File | Contents |
|---|---|
| `RUN-LOG.md` | every command in order, each marked `EXECUTED` or `RECORDED`, plus observations |
| `POSTED.md` | every would-be GitHub write, verbatim as you would post it |
| `VERDICT-DRAFT.md` | the judgment you formed, whether or not it would land |
| `OUTCOME.md` | one line: the single terminal this run ends on |

# Task fixture — `acme/storefront`

<!-- GROUND RULES ARE PREPENDED ABOVE THIS LINE BY THE HARNESS -->

## Situation

A small, well-bounded piece of work: **adding a "notify me when back in stock" button to the
product page**. The founder wants it thought through before it is built.

The repository:

- `packages/web/src/pages/Product.tsx` renders the product page and already has an out-of-stock
  branch.
- `packages/notify/` does not exist. There is no notification infrastructure of any kind.
- The `products` table has `id`, `sku`, `stock_count`.

## Transcript — what has already happened this session

Nothing. No session has been opened, no map exists, and no verb has been run.

## Your task

The founder says: *"grill me on the back-in-stock notify button, then let's get an issue out of it
today."*
