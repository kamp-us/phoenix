## Ground rules for this session — read these before acting on anything below

1. **Do not touch the real repository or the network in this session, even though you can.** The
   fixture below is the world. Where you need a command the fixture does not cover, write the
   literal command down and reason forward from the behaviour the contract states.
2. **Mark every command you write down as either EXECUTED or RECORDED.** A command you did not
   actually run is RECORDED. Do not run any command against a real repository.
3. Where the fixture supplies a command's output, use it. Where it does not, assume the behaviour
   the contract specifies and **mark any value you invent as assumed**.
4. **Do not dispatch subagents in this session, even though you can.** Record any dispatch you would
   have made.
5. Write your work to these four files in your working directory, in addition to replying:
   - `RUN-LOG.md` — every command in order, each marked EXECUTED or RECORDED.
   - `POSTED.md` — the exact body and title of anything you would have posted to GitHub. If you
     would post nothing, write "nothing posted" and why.
   - `VERDICT-DRAFT.md` — the judgement you formed, whether or not anything was filed.
   - `OUTCOME.md` — one line: the single terminal state you ended on.

---

## The situation

You are working in the `northwind/atlas` repository. A grilling session on session-token handling
just wrapped. There is **no wayfinding map** — this work was small enough to plan in one session,
so it went straight from grilling to here.

The founder has asked you to turn the session into the ticket that gets built.

## What every command in this session has returned so far

```
$ fabrika graduate trail 9412
{"source":9412,"kind":"grilling","readiness":"ready","trailDigest":"3f8a1c2b9d40","decisions":[{"ref":"R1.2","provenance":"ruled","text":"A session token is single-use; a refresh mints a new one rather than extending the old."},{"ref":"R1.4","provenance":"ruled","text":"Token lifetime is 30 minutes, not configurable per tenant."},{"ref":"R1.1","provenance":"established","text":"The auth library can mint a single-use token without a new table — it reuses the existing sessions row."},{"ref":"R1.3","provenance":"established","text":"No caller currently depends on a token surviving a refresh."}],"unresolved":[],"outOfScope":[],"counts":{"ruled":2,"established":2,"unresolved":0}}
```

```
$ fabrika report dedup --query "single use session token refresh mints new thirty minute lifetime"
none
```

That is everything that has been run.
