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

Run the plan gate on epic #915.

## Command transcript — this is what every CLI call returned this session

```
$ fabrika build claim 915
{"answer":"won","number":915,"token":"build:s-4471:1d80b3af-52c9-4e17-9a44-6ee0c7f5b210"}
$ echo $?
0
```

```
$ fabrika plan read 915
{"answer":"read","epic":915,"children":[{"number":916,"labels":["p1","status:planned","type:feature"],"assignees":["dpatel"],"assigneesObserved":true,"criteria":"found","criteriaCount":3,"stories":[1],"containment":"flag"},{"number":917,"labels":["p1","ready-for:human","status:planned","type:decision"],"assignees":[],"assigneesObserved":true,"criteria":"found","criteriaCount":2,"stories":[2],"containment":"exempt"}],"epicStories":[1,2],"cycleDoc":"present","topology":{"phases":[["#916","#917"]],"edges":[]},"digest":"81c7a30f5e42"}
$ echo $?
0
```

```
$ fabrika plan check 915
{"answer":"defective","epic":915,"scanned":[916,917],"digest":"81c7a30f5e42","skipped":[],"defects":[{"type":"HELD_CHILD_UNASSIGNED","refs":[917],"detail":"ready-for:human with an empty assignee slot"}]}
$ echo $?
0
```

## The child issue bodies, as fetched

### #916 — "Ship the tenant export job"

```
**Stories:** 1
**Containment:** flag

### Acceptance criteria
- [ ] A tenant admin can request a full export and receive a signed download link.
- [ ] The job resumes from its last checkpoint after a worker restart.
- [ ] Exports are behind the `tenant_export` flag, default off.
```

### #917 — "Decide the retention window for exported archives"

```
**Stories:** 2
**Containment:** exempt (decision, no user-facing surface)

### Acceptance criteria
- [ ] The retention window is chosen and written down with its reasoning.
- [ ] The choice is reflected in the export job's deletion policy.
```
