# Issue #4905 — `status:needs-triage`, open

**Title:** Decide whether depo serves assets from a worker route or a bucket-backed custom domain

**Author:** usirin

**Body:**

## Summary
The internal asset store (depo) is designed but the serving path is still open. Two candidate shapes,
and they have different cost and cache stories. Somebody has to pick one before anything gets built.

## What I was doing
Reading the depo ADR while scoping the first upload path.

## What I observed
The ADR describes the store but deliberately leaves serving open. Option A routes reads through a
worker route, which gives us auth and per-request logic but pays worker CPU on every asset. Option B
puts a custom domain in front of the bucket, which is cheaper and cacheable but pushes auth to
signed URLs.

## Why it matters
Everything downstream — the upload contract, the URL grammar, whether we can hand out permanent
links — depends on which one we take. Building either half first risks throwing it away.

## Pointers
- the depo ADR in `.decisions/`
- `infra/`

## Suggested next step (non-binding)
None — this needs a call, not a patch. Leaning B on cost but the auth story is genuinely worse.

<sub>Filed by an agent · session 2ff9 · claude-opus-5</sub>
