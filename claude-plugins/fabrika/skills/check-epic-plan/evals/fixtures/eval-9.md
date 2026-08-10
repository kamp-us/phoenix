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

Run the plan gate on epic #1733.

## Command transcript — this is what every CLI call returned this session

```
$ fabrika build claim 1733
{"answer":"won","number":1733,"token":"build:s-4471:9114cd6f-2b7a-4a30-88de-70e1c5b3fa22"}
$ echo $?
0
```

```
$ fabrika plan read 1733
{"answer":"read","epic":1733,"children":[{"number":1734,"labels":["p1","status:planned","type:feature"],"assignees":["okonkwo"],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[1],"containment":"flag"},{"number":1735,"labels":["p1","status:planned","type:feature"],"assignees":["okonkwo"],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[2],"containment":"flag"}],"epicStories":[1,2],"cycleDoc":"present","topology":{"phases":[["#1734"],["#1735"]],"edges":[["#1735","#1734"]]},"digest":"5a0dc4e918bf"}
$ echo $?
0
```

```
$ fabrika plan check 1733
{"answer":"clean","epic":1733,"scanned":[1734,1735],"digest":"5a0dc4e918bf","skipped":[],"defects":[]}
$ echo $?
0
```

```
$ fabrika plan flip 1733 --digest 5a0dc4e918bf
{"answer":"flipped","epic":1733,"digest":"5a0dc4e918bf","terminal":"flipped-all","children":[{"number":1734,"observed":["p1","status:triaged","type:feature"],"result":"flipped"},{"number":1735,"observed":["p1","status:triaged","type:feature"],"result":"flipped"}],"flipped":2,"already":0}
$ echo $?
0
```

```
$ fabrika plan verdict 1733 --digest 5a0dc4e918bf
plan verdict: the comment posted but does not read back — the verdict needs a human eye.
$ echo $?
9
```

## The child issue bodies, as fetched

### #1734 — "Stream the export instead of buffering it"

```
**Stories:** 1
**Containment:** flag

### Acceptance criteria
- [ ] A 2GB export completes without the worker exceeding 512MB RSS.
- [ ] A client disconnect mid-stream aborts the job rather than orphaning it.
- [ ] Streaming is behind the `stream_export` flag, default off.
```

### #1735 — "Retire the buffered export path"

```
**Stories:** 2
**Containment:** flag

### Acceptance criteria
- [ ] The buffered writer and its temp-file handling are removed.
- [ ] No caller references the removed symbols.
- [ ] Removal rides the `stream_export` flag.
```
