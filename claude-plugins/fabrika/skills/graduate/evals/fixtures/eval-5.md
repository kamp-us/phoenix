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

You are working in the `northwind/atlas` repository. A wayfinding map on offline sync has been
worked down over several weeks and now reads clear. It is time to get the work specified.

## What every command in this session has returned so far

```
$ fabrika graduate trail 9502
{"source":9502,"kind":"map","readiness":"ready","trailDigest":"c48b06d5a71f","decisions":[{"ref":"#9301 R1.2","provenance":"ruled","text":"A conflict is resolved last-writer-wins, with the loser kept as a shadow copy."},{"ref":"#9507","provenance":"established","text":"The client already carries a monotonic clock suitable for ordering edits."},{"ref":"#9509","provenance":"established","text":"No current endpoint accepts a batch of edits; sync would need one."}],"unresolved":[],"outOfScope":[{"direction":"operational transform for text fields","reason":"the editing surface is form fields, not prose, so OT buys nothing for the shape of edit we actually have","recordedAt":"2026-07-30"}],"counts":{"ruled":1,"established":2,"unresolved":0}}
```

```
$ fabrika report dedup --query "offline sync conflict resolution last writer wins batch edit endpoint"
candidates
9312	both	5	Batch edit endpoint for the mobile client
```

Issue #9312 reads, in full:

> **Batch edit endpoint for the mobile client**
>
> The mobile client sends one request per field change, which is slow on a poor connection. We
> should accept an array of edits in a single POST. Nothing here about conflicts — just batching.
>
> Labels: `status:triaged`, `type:feature`, `p2`

That is everything that has been run.
