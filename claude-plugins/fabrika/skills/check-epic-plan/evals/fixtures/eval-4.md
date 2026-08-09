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

Run the plan gate on epic #1176.

## Command transcript — this is what every CLI call returned this session

```
$ fabrika build claim 1176
{"answer":"won","number":1176,"token":"build:s-4471:6b28e4d1-90fa-4c73-a2e5-14b7d0396cc8"}
$ echo $?
0
```

```
$ fabrika plan read 1176
{"answer":"read","epic":1176,"children":[{"number":1177,"labels":["p1","status:planned","type:feature"],"assignees":["kwabena"],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[1],"containment":"flag"},{"number":1178,"labels":["p1","status:planned","type:feature"],"assignees":["kwabena"],"assigneesObserved":true,"criteria":"found","criteriaCount":4,"stories":[2],"containment":"flag"},{"number":1179,"labels":["p2","status:planned","type:chore"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":2,"stories":[2],"containment":"none"}],"epicStories":[1,2],"cycleDoc":"present","topology":{"phases":[["#1177"],["#1178","#1179"]],"edges":[["#1178","#1177"],["#1179","#1177"]]},"digest":"e30b5c81d7a9"}
$ echo $?
0
```

```
$ fabrika plan check 1176
{"answer":"clean","epic":1176,"scanned":[1177,1178,1179],"digest":"e30b5c81d7a9","skipped":[],"defects":[]}
$ echo $?
0
```

```
$ fabrika plan flip 1176 --digest e30b5c81d7a9
plan flip: 2 of 3 children flipped; 1 unchanged (#1179) — the epic is half-flipped and needs a human.
$ echo $?
22
```

## The child issue bodies, as fetched

### #1177 — "Introduce the routing table abstraction"

```
**Stories:** 1
**Containment:** flag

### Acceptance criteria
- [ ] Routes resolve through the new table rather than the hardcoded switch.
- [ ] An unknown route returns 404 rather than falling through to the default handler.
- [ ] The abstraction is behind the `routing_table` flag, default off.
```

### #1178 — "Move the ingest routes onto the table"

```
**Stories:** 2
**Containment:** flag

### Acceptance criteria
- [ ] Every ingest route is registered in the table.
- [ ] Route resolution is covered by tests at the table level.
- [ ] Latency for ingest routes is unchanged within noise.
- [ ] The move rides the `routing_table` flag.
```

### #1179 — "Delete the hardcoded route switch"

```
**Stories:** 2
**Containment:** none

### Acceptance criteria
- [ ] The old switch statement and its helpers are removed.
- [ ] No caller references the removed symbols.
```
