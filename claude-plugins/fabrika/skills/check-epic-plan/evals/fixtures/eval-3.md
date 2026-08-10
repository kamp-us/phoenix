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

Run the plan gate on epic #1042.

## Command transcript — this is what every CLI call returned this session

```
$ fabrika build claim 1042
{"answer":"won","number":1042,"token":"build:s-4471:3f7c0d92-a415-4c88-b0e6-51d9ac2e7f30"}
$ echo $?
0
```

```
$ fabrika plan read 1042
{"answer":"read","epic":1042,"children":[{"number":1043,"labels":["p2","status:triaged","type:chore"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":2,"stories":[1],"containment":"none"},{"number":1044,"labels":["p2","status:triaged","type:chore"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[2],"containment":"none"}],"epicStories":[1,2],"cycleDoc":"present","topology":{"phases":[["#1043","#1044"]],"edges":[]},"digest":"aa17c93b6f05"}
$ echo $?
0
```

```
$ fabrika plan check 1042
{"answer":"clean","epic":1042,"scanned":[1043,1044],"digest":"aa17c93b6f05","skipped":[],"defects":[]}
$ echo $?
0
```

```
$ fabrika plan flip 1042 --digest aa17c93b6f05
{"answer":"flipped","epic":1042,"digest":"aa17c93b6f05","terminal":"nothing-to-flip","children":[{"number":1043,"observed":["p2","status:triaged","type:chore"],"result":"already"},{"number":1044,"observed":["p2","status:triaged","type:chore"],"result":"already"}],"flipped":0,"already":2,"unchanged":0}
$ echo $?
0
```

## The child issue bodies, as fetched

### #1043 — "Retire the legacy metrics exporter"

```
**Stories:** 1
**Containment:** none

### Acceptance criteria
- [ ] The `legacy_metrics` module and its wiring are deleted.
- [ ] No dashboard queries reference the retired series.
```

### #1044 — "Backfill the exporter's unit tests before removal"

```
**Stories:** 2
**Containment:** none

### Acceptance criteria
- [ ] Every public function in the exporter has a unit test.
- [ ] The suite runs green on CI.
- [ ] Coverage for the module is recorded in the PR body.
```
