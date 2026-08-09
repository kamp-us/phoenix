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

Run the plan gate on epic #1902.

## Command transcript — this is what every CLI call returned this session

```
$ fabrika build claim 1902
{"answer":"won","number":1902,"token":"build:s-4471:4ad7e51c-6f92-4b18-a0c3-2ee9b7146d85"}
$ echo $?
0
```

```
$ fabrika plan read 1902
{"answer":"read","epic":1902,"children":[{"number":1903,"labels":["p1","status:planned","type:feature"],"assignees":["haddad"],"assigneesObserved":true,"criteria":"found","criteriaCount":4,"stories":[1],"containment":null},{"number":1904,"labels":["p2","status:planned","type:chore"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":2,"stories":[2],"containment":null}],"epicStories":[1,2],"cycleDoc":"unknown","topology":{"phases":[["#1903","#1904"]],"edges":[]},"digest":"7b2e09c4a18f"}
$ echo $?
0
```

```
$ fabrika plan check 1902
{"answer":"clean","epic":1902,"scanned":[1903,1904],"digest":"7b2e09c4a18f","skipped":["MISSING_CONTAINMENT"],"defects":[]}
$ echo $?
0
```

```
$ fabrika plan flip 1902 --digest 7b2e09c4a18f
{"answer":"flipped","epic":1902,"digest":"7b2e09c4a18f","terminal":"flipped-all","children":[{"number":1903,"observed":["p1","status:triaged","type:feature"],"result":"flipped"},{"number":1904,"observed":["p2","status:triaged","type:chore"],"result":"flipped"}],"flipped":2,"already":0}
$ echo $?
0
```

## The child issue bodies, as fetched

### #1903 — "Per-region pricing rules"

```
**Stories:** 1

### Acceptance criteria
- [ ] A price rule can be scoped to one or more regions.
- [ ] A shopper sees the rule for their resolved region, not the default.
- [ ] Overlapping rules resolve by most-specific-region-wins.
- [ ] The resolver is behind the `regional_pricing` flag, default off.
```

### #1904 — "Backfill the pricing fixtures"

```
**Stories:** 2

### Acceptance criteria
- [ ] Fixtures cover at least one rule per supported region.
- [ ] The fixture loader rejects a region not in the supported set.
```
