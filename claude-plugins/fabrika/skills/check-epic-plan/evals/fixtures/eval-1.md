# Session world — `northwind/atlas`

## Ground rules — read these before you do anything

- You have **no repository or network access** in this session. Treat any CLI or shell invocation
  against the real environment as out of bounds — including orienting commands like `git remote -v`
  or `gh repo view`. **The transcript below is the world.** A command the transcript does not cover
  behaves exactly as its documentation says: record what you would have run and proceed on the
  documented behaviour.
- Record your work in four files in the current directory:
  - `RUN-LOG.md` — every command you ran or would have run, in order, and what you concluded from
    each. Label anything you inferred rather than read.
  - `POSTED.md` — the exact text of anything you would write to GitHub (comments, labels), or
    "nothing posted" with the reason.
  - `VERDICT-DRAFT.md` — the judgement you formed, whether or not it lands.
  - `OUTCOME.md` — one line: how the run ended.

## The ask

Run the plan gate on epic #820.

## Command transcript — this is what every CLI call returned this session

```
$ fabrika build claim 820
{"answer":"won","number":820,"token":"build:s-4471:9c2f10ea-77d1-4b03-8e5a-2a6cf0d19b84"}
$ echo $?
0
```

```
$ fabrika plan read 820
{"answer":"read","epic":820,"children":[{"number":821,"labels":["p1","status:planned","type:feature"],"assignees":["rmoreno"],"assigneesObserved":true,"criteria":"found","criteriaCount":4,"stories":[1],"containment":"flag"},{"number":822,"labels":["p2","status:planned","type:chore"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":2,"stories":[2],"containment":"none"}],"epicStories":[1,2],"cycleDoc":"present","topology":{"phases":[["#821"],["#822"]],"edges":[["#822","#821"]]},"digest":"4d90e1bb27ac"}
$ echo $?
0
```

```
$ fabrika plan check 820
{"answer":"clean","epic":820,"scanned":[821,822],"digest":"4d90e1bb27ac","skipped":[],"defects":[]}
$ echo $?
0
```

The transcript ends here. Anything further is yours to decide and to record.

## The child issue bodies, as fetched

### #821 — "Add per-tenant rate limiting to the ingest endpoint"

```
**Stories:** 1
**Containment:** flag

### Acceptance criteria
- [ ] A tenant exceeding its configured rate receives HTTP 429 with a `Retry-After` header.
- [ ] The limit is read from the tenant record, not a global constant.
- [ ] Requests under the limit are unaffected — p99 latency moves less than 2ms.
- [ ] The behaviour is behind the `ingest_rate_limit` flag, default off.
```

### #822 — "Clean up the ingest fixtures"

```
**Stories:** 2
**Containment:** none

### Acceptance criteria
- [ ] The duplicated fixture files under `test/ingest/` are consolidated.
- [ ] The suite is in better shape afterwards.
```
