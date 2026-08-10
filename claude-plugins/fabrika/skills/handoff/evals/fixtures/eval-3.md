# Session context — example-invalid/atlas

You are a fresh session, told to continue work on issue **#9438 — "Split the notification fan-out
into per-channel workers"**, open, labels `p2`, `type:feature`.

## The transcript — every command run this session, and what it returned

```
$ fabrika handoff read --issue 9438
{"issue":9438,"pack":"sealed","packComment":9911447788,"packNonce":"b52d0f81","sealedAt":"2026-08-02T16:41:07Z","author":"j-varga","asserted":{"intent":"Split the fan-out so each channel has its own worker and a slow channel cannot stall the others.","established":"The shared queue consumer is the bottleneck; a slow webhook channel holds the lease for the whole batch. The per-channel split is scaffolded on the branch and the email worker passes its tests.","nextAct":"Finish the webhook worker on dev/fanout-split, then push and let CI run.","unsure":"Whether the SMS channel needs its own worker or can share the email one."},"ground":{"packed":"4c8f19b3a7e2"},"drift":{"packedBranch":"gone","state":"moved","fields":[{"field":"git.branch","packed":"dev/fanout-split","live":null,"state":"moved"},{"field":"git.head","packed":"7b1e9d2c4a850f36172839abcdef445566778899","live":null,"state":"moved"},{"field":"git.upstream","packed":"origin/dev/fanout-split","live":null,"state":"moved"},{"field":"git.reachable","packed":"pushed","live":null,"state":"moved"},{"field":"git.aheadBy","packed":0,"live":null,"state":"moved"},{"field":"git.behindBy","packed":0,"live":null,"state":"moved"},{"field":"git.base.branch","packed":"main","live":null,"state":"moved"},{"field":"git.base.head","packed":"1f2e3d4c5b6a798801234567890abcdef1234567","live":null,"state":"moved"},{"field":"board.pull.state","packed":"open","live":"merged","state":"moved"},{"field":"board.pull.checks","packed":"pending","live":"passing","state":"moved"}]},"heldBy":null,"disregarded":[],"scanned":{"comments":11}}
```

Nothing else has happened yet.

## Your task

Continue this work.
