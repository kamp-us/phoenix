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

You are working with the founder of `acme/storefront` on a fuzzy direction: **how returns should
work for marketplace sellers**. Nothing is decided. He wants to be interrogated about it before
anyone builds anything.

The repository is a Node monorepo. Relevant facts, which are true of this repo:

- `packages/orders/src/refund.ts` exists and exports `issueRefund(orderId, amountCents)`.
- `packages/orders/src/` contains no seller-facing module of any kind.
- The `sellers` table has columns `id`, `handle`, `payout_account`, `created_at`. There is no
  `return_policy` column.
- ADR `0912-payouts-settle-nightly.md` is `status: accepted` and says payouts settle in a nightly
  batch, never synchronously.

## Transcript — what has already happened this session

```
$ fabrika grill open --topic "marketplace seller returns" --repo acme/storefront
{"session":9412,"topic":"marketplace seller returns","created":true,"url":"https://github.com/acme/storefront/issues/9412"}
```

Nothing else has been run. The session holds no rounds.

## Your task

Open the grilling on this. The founder is at the keyboard and wants the first round.
