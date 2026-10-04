---
id: 0450
title: A park that names no cause is refused by default, never recorded bare
status: accepted
date: 2026-10-04
tags: [fabrika, lane, pipeline, config]
---

# 0450 — A park that names no cause is refused by default, never recorded bare

**What this decides:** a repo that declares nothing about `parkCause.uncaused` gets `refuse`, so a
`BLOCKED` with no cause is refused at exit 52 and the lane log is left alone. A repo that wants the
bare park declares `"uncaused": "record"`.

## Context

ADR [0376](0376-driver-seat-for-non-product-parks.md) put a route on every park cause and shipped two
config sub-keys off: *"`parkCause.uncaused` ships `record`, so a cause-less `BLOCKED` is still
recorded rather than refused at exit 52. Both defaults are today's behaviour, which is what a shipped
default is for."* The reason then was that shells in flight still reported the bare park on some
path, so a strict default would have stopped those lanes mid-drive.

An adopting repo then reported what that default costs
([#10310](https://github.com/kamp-us/phoenix/issues/10310)). Its driver recorded four parks with no
cause in one day. `recipe unpark` keys on the cause, so each one read as novel and went to a person.
The repo never saw exit 52 because it had declared nothing, and the adoption guide did not name the
key.

The founder ruled on it on 2026-10-03, on
[the ruling comment](https://github.com/kamp-us/phoenix/issues/10310#issuecomment-5974127475). Asked
*"Should a new repo refuse a hold that gives no reason, out of the box?"*, he chose *"Yes"*, with the
note: *"we should be as helpful as possible for people trying to use fabrika and help them in ways
that their agents can pick up and figure out how to do."* This record transcribes that ruling. It
makes no new choice.

This record amends 0376 in part. Only the one sentence quoted above changes. 0376's routes, its
clearing arm and `parkCause.driverRouted`'s shipped `refuse` stand as written.

## Decision

**`parkCause.uncaused` ships `refuse`, and `record` is a repo's own declaration.**

`lane transition` and `lane report` both refuse a `BLOCKED` that carries no `--cause` at exit 52 with
the log unappended, in any repo whose `.fabrika.jsonc` does not say otherwise. The refusal names the
setting and the `record` value, so an agent that reads only the refusal can find the way back.

A repo that prefers the earlier behaviour declares it:

```jsonc
"parkCause": {"uncaused": "record"}
```

No generic `driver-hold` cause is added, and setup writes no `parkCause` key into a new repo's
config. The default does that job.

**Binding constraints.**

- The exit 52 refusal names `parkCause.uncaused` and the `record` value.
- The adoption guide's settings table names `parkCause`, its three sub-keys and their shipped values.

## Consequences

A driver hold in an undeclaring repo either names a cause a recipe or a route can act on, or it is
not recorded. Bare parks stop reaching a person by default.

A hold with no fitting cause token cannot be parked at all under `refuse`. The lane stays in its
stage and can look abandoned, which this repo met in
[#10290](https://github.com/kamp-us/phoenix/issues/10290). The ruling accepts that trade. Each
missing token is its own ticket, and until one lands the repo's way out is `record`.

This is a breaking change for a repo that upgrades the CLI and relied on the old default. Its
migration is the one line above.

Sources: the founder ruling at
[#10310, comment 5974127475](https://github.com/kamp-us/phoenix/issues/10310#issuecomment-5974127475);
ADR [0376](0376-driver-seat-for-non-product-parks.md) (amended in part by this record);
[`packages/fabrika-cli/src/config/keys/park-cause.ts`](../packages/fabrika-cli/src/config/keys/park-cause.ts),
[`packages/fabrika-cli/src/lane/report.ts`](../packages/fabrika-cli/src/lane/report.ts),
[`claude-plugins/fabrika/guide/adopt-fabrika-in-a-new-repo.md`](../claude-plugins/fabrika/guide/adopt-fabrika-in-a-new-repo.md).
