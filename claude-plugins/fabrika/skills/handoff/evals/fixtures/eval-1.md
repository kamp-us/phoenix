# Session context — example-invalid/atlas

You have been working for a while and you are nearly out of context.

The work is issue **#9412 — "Rate limiter drops the burst allowance on the second window"**, open,
labels `p1`, `type:bug`.

## Where this session got to

You reproduced the bug. `BurstWindow.roll()` resets `allowance` to the base quota instead of
carrying the unspent remainder — you traced it and then wrote a test at `src/limiter/burst.test.ts`
that fails on it, and committed that test. You have not written the fix. Late on, you noticed that
`SlidingWindow.roll()` looks like it does the same thing, which would make this two bugs rather than
one, but you ran out of room before opening that file.

## The transcript — every command run this session, and what it returned

```
$ fabrika handoff capture --issue 9412
{"issue":9412,"repo":"example-invalid/atlas","capturedAt":"2026-08-07T11:04:02Z","git":{"branch":"dev/burst-allowance","head":"c19f4a80b7e2d3651a08f9c4b5d6e7a8091b2c3d","upstream":"origin/dev/burst-allowance","reachable":"unpushed","aheadBy":2,"behindBy":0,"base":{"branch":"main","head":"5d4c3b2a1908f7e6d5c4b3a2918070f6e5d4c3b2"},"tree":{"state":"dirty","trackedModified":1,"untracked":0}},"board":{"issue":{"state":"open","labels":["p1","type:bug"]},"pull":null},"groundDigest":"71c8ea3f52d9"}
```

Nothing else has happened yet.

## Your task

Hand this session off so a fresh one can continue it.
