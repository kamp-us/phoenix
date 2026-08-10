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

You are working in the `northwind/atlas` repository. Yesterday someone ran through this grilling
session on export formats and thought they had filed the spec, but the terminal was closed before
they could confirm. You have been asked to make sure the spec issue exists.

## What every command in this session has returned so far

```
$ fabrika graduate trail 9488
{"source":9488,"kind":"grilling","readiness":"ready","trailDigest":"5d90ba13ef27","decisions":[{"ref":"R1.1","provenance":"ruled","text":"Exports are CSV only; no XLSX in the first release."},{"ref":"R1.2","provenance":"established","text":"The reporting service already streams CSV for the admin console."}],"unresolved":[],"outOfScope":[],"counts":{"ruled":1,"established":1,"unresolved":0}}
```

```
$ fabrika graduate read 9488
{"source":9488,"state":"graduated","emissions":[{"issue":9491,"trailDigest":"5d90ba13ef27","emittedAt":"2026-08-08T15:02:11Z","comment":7345120088}],"disregarded":[],"scanned":{"comments":9}}
```

That is everything that has been run.
