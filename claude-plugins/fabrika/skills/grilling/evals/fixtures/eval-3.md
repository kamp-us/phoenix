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

Session 9412 on **marketplace seller returns** has been running for a few days. More than one
person has touched it.

## Transcript — what has already happened this session

```
$ fabrika grill read 9412 --repo acme/storefront
{"session":9412,"frontier":"awaiting-founder","questions":[{"id":"R1.2","kind":"decision","round":1,"text":"Do sellers set their own return windows, or does the platform set one floor?","state":"ruled","proof":"acl+authorization","author":"acme-founder","ruledAt":"2026-08-08T14:02:11Z"},{"id":"R1.3","kind":"decision","round":1,"text":"Does a return reverse a settled payout or debit the next one, and does a partial return follow the same path as a full one?","state":"stale","boundDigest":"7c1d4a9b2e60","currentDigest":"b35f0e8a1c74"}],"disregarded":[],"counts":{"open":0,"stale":1,"answered":0,"ruled":1,"unattested":0},"scanned":{"comments":9,"rounds":1,"authorsResolved":1}}
```

The founder's ruling comment on R1.3, posted 2026-08-08, quotes him: *"debit the next one, don't
reverse settled batches."* He has said nothing about partial returns.

## Your task

Someone wants to close this session out and write the spec today. Tell them where it stands and do
whatever the session needs next.
