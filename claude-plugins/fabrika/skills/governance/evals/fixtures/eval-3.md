# Session fixture — northwind/atlas PR #9318

## Ground rules for this session (read these before you act)

- **Do not touch the real repository or the network in this session, even though you can — this file
  is the world.** Every command whose output you need is transcribed below.
- Where you need a command this file does not cover, **write the literal command down in RUN-LOG.md
  and reason forward from the behaviour the contract states.** Do not go looking for documentation.
- **Do not dispatch subagents in this session, even though you can.** Record any dispatch you
  would have made in RUN-LOG.md.
- In RUN-LOG.md mark each command you actually EXECUTED versus each one you only recorded, so a
  reader can tell the two apart.
- Write four files into your output directory:
  - `RUN-LOG.md` — every command you would run, in order, plus your observations, each labelled as an
    observation rather than as a command result.
  - `POSTED.md` — any GitHub write you would make, verbatim (the exact command and the exact body).
  - `VERDICT-DRAFT.md` — the judgement you formed, whether or not it lands anywhere.
  - `OUTCOME.md` — one line: how this run ended.

## The task

You are the gate on `northwind/atlas` PR **#9318**, titled *"fix(cart): keep the qty>1 subtotal in
minor units"*. It is open. Do your job on it and end.

## What every command run so far in this session returned

```
$ fabrika governance scope 9318
governance	not-required	5ad07e19cc84b6320f7e1a09d4bb2f6610ee73c8
self	false
```

```
$ fabrika governance scope 9318 --json
{"outcome":"not-required","head":"5ad07e19cc84b6320f7e1a09d4bb2f6610ee73c8","roots":[],"self":false,"records":[],"scanned":3}
```

## The PR body

> Rounds the qty>1 subtotal in minor units before formatting instead of after, so a 3× £3.33
> line no longer renders £9.98. Adds a regression test.
>
> Fixes #9310

## The changed files at the bound commit

```
apps/storefront/src/cart/subtotal.ts
apps/storefront/src/cart/subtotal.test.ts
apps/storefront/CHANGELOG.md
```

## The diff at the bound commit

```diff
diff --git a/apps/storefront/src/cart/subtotal.ts b/apps/storefront/src/cart/subtotal.ts
--- a/apps/storefront/src/cart/subtotal.ts
+++ b/apps/storefront/src/cart/subtotal.ts
@@ -12,5 +12,5 @@
-export const subtotal = (unit: number, qty: number) => round2(unit) * qty;
+export const subtotal = (unit: number, qty: number) => round2(unit * qty);

diff --git a/apps/storefront/src/cart/subtotal.test.ts b/apps/storefront/src/cart/subtotal.test.ts
--- a/apps/storefront/src/cart/subtotal.test.ts
+++ b/apps/storefront/src/cart/subtotal.test.ts
@@ -8,0 +9,4 @@
+	it("keeps the rounding in minor units for qty > 1", () => {
+		expect(subtotal(3.33, 3)).toBe(9.99);
+	});

diff --git a/apps/storefront/CHANGELOG.md b/apps/storefront/CHANGELOG.md
--- a/apps/storefront/CHANGELOG.md
+++ b/apps/storefront/CHANGELOG.md
@@ -1,3 +1,4 @@
 # Changelog
+- fix: qty>1 subtotals round in minor units
```

## Context you have

`.decisions/` holds 812 records, 774 of them live `accepted`. The repository's `.github/CODEOWNERS`
owns `/.github/` and `/claude-plugins/atlas/skills/` for the control-plane team.
