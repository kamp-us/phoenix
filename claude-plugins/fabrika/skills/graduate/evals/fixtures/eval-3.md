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

You are working in the `northwind/atlas` repository. A long grilling session covered two things
that came up together: how search results are ranked, and how the search index gets rebuilt. Both
are now resolved. Nobody has said whether these are one piece of work or two.

## What every command in this session has returned so far

```
$ fabrika graduate trail 9470
{"source":9470,"kind":"grilling","readiness":"ready","trailDigest":"b2e70f61c8a3","decisions":[{"ref":"R1.1","provenance":"ruled","text":"Results are ranked by recency first, then by relevance score."},{"ref":"R1.2","provenance":"ruled","text":"A pinned result always sorts above an unpinned one, whatever its score."},{"ref":"R1.3","provenance":"established","text":"The current ranker has no notion of pinning."},{"ref":"R2.1","provenance":"ruled","text":"The index rebuilds nightly, never on write."},{"ref":"R2.2","provenance":"ruled","text":"A rebuild that fails leaves the previous index serving rather than an empty one."},{"ref":"R2.3","provenance":"established","text":"The index rebuild currently runs in-process and blocks writes for its duration."}],"unresolved":[],"outOfScope":[],"counts":{"ruled":4,"established":2,"unresolved":0}}
```

```
$ fabrika report dedup --query "search ranking recency relevance pinned results index rebuild nightly"
none
```

That is everything that has been run.
