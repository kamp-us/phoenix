# @kampus/aria-voice-guard

The CI guard that keeps the **lowercase anti-hype Turkish voice** from re-drifting at
the a11y / persistent-menu seam (issue #1670).

## Why it exists

The lowercase register is the brand's voice, but it kept breaking where a sighted user
never looks: `aria-label` copy and persistent menu items were Title Case, so a
screen-reader user heard a more formal, corporate persona than the visible UI. Issue
#1670 lowercased every offending string (`"Kapat"` → `"kapat"`, `"Yukarı oy"` →
`"yukarı oy"`, the user-menu `"Profil"`/`"Ayarlar"`/`"Çıkış"`, …). This package is the
**anti-re-drift half**: a lint-style scan that fails CI the moment a *new* Title-Case
aria-label or menu-item string lands, so the register can't silently slide back.

Turkish product/brand copy stays Turkish — this is purely a **casing** rule, never a
translation (per [CLAUDE.md](../../CLAUDE.md) / [`.glossary/LANGUAGE.md`](../../.glossary/LANGUAGE.md)).

## What it checks

A `.tsx` file's:

- **aria-label values** — every string literal inside an `aria-label` attribute,
  including both branches of a `aria-label={cond ? "A" : "B"}` ternary. A fully-dynamic
  `aria-label={expr}` (a variable or an interpolated template) has no fixed copy string,
  so it is out of scope.
- **persistent menu items** — the plain text child of a `<Menu.Item>…</Menu.Item>`
  (single- or multi-line). A `{expr}` child is out of scope.

A candidate is **drift** when its first *cased* letter is uppercase.

## Turkish-locale casing (the load-bearing part)

Turkish has the dotted/dotless-i pair — `İ`/`i` and `I`/`ı`. All case decisions and
lowercasing go through `toLocaleLowerCase("tr")` / `toLocaleUpperCase("tr")`, never a
naive `toLowerCase()`:

- `"İletişim"` lowercases to `"iletişim"` (no stray combining dot).
- `"Istanbul"` lowercases to `"ıstanbul"` — dotless-I → `ı`, **not** `"istanbul"`.
- A word that begins with an already-lowercase `ı` or `i` is never a false positive.

The core (`firstCasedIsUpper` + `findDrift`) is pure and IO-free; its Turkish-i edge
cases are pinned in [`src/aria-voice-guard.unit.test.ts`](./src/aria-voice-guard.unit.test.ts).

## Usage

```bash
# scan one or more .tsx files; exit 2 on any drift, 0 when clean
node packages/aria-voice-guard/src/bin.ts scan apps/web/src/components/ui/Dialog.tsx
```

CI runs it over every changed `apps/web/src/**/*.tsx` file on each PR — see
[`.github/workflows/aria-voice-guard.yml`](../../.github/workflows/aria-voice-guard.yml).
The exit-code contract mirrors `leak-guard`: `2` = a confirmed drift (report on
stderr), `0` = clean, any other non-zero = the scan could not complete (CI fails closed).

## Layout

- `src/aria-voice-guard.ts` — the pure, Turkish-locale-correct matcher (`findDrift`).
- `src/bin.ts` — the thin `effect/unstable/cli` shell (`aria-voice-guard scan <files>`).
- `src/index.ts` — the package's public surface.
- `src/aria-voice-guard.unit.test.ts` — the unit suite, incl. the Turkish-i corpus.
