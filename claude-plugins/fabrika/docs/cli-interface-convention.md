# cli-interface-convention — split into two pages

This page served two audiences in one file and was split
([#7021](https://github.com/kamp-us/phoenix/issues/7021)). It no longer holds the content itself;
every section moved intact:

- **The CLI interface convention** — what a verb owes its caller (`--help` discoverability, output
  channels, exit codes, fail-closed scope, literal invocations, delivery, no-outside-calls) — now
  lives at **[interface-convention.md](interface-convention.md)**.
- **The contract-spec format** — what an authoring session emits per skill (`contract.md`: required
  sections, completeness test, worked example) — now lives at
  **[contract-spec-format.md](contract-spec-format.md)**.

The rule for deep links: every fragment that resolved on this path still resolves on one of the two
new pages unchanged, because the section headings kept their text. Part 1's fragments (rules 1–6,
*Delivery*, *Enforcement*) resolve on `interface-convention.md`; Part 2's fragments (*Required
sections*, *Completeness test*, *Worked example*) resolve on `contract-spec-format.md`.

| Was here | Now |
|---|---|
| [Part 1 — the interface convention](interface-convention.md) | rules 1–6 with *Delivery* under rule 5 |
| [`#3-the-exit-status-is-the-answer-empty-stdout-never-is`](interface-convention.md#3-the-exit-status-is-the-answer-empty-stdout-never-is) | same fragment, `interface-convention.md` |
| [*Delivery — one name, two installs, both of them real*](interface-convention.md#delivery--one-name-two-installs) | same fragment, under rule 5 |
| [Part 2 — the contract-spec format](contract-spec-format.md) | required sections, completeness test, worked example |

Update links you own to point at the new pages directly; this note keeps links you do not own
resolvable until the index sweep folds them ([#6490](https://github.com/kamp-us/phoenix/issues/6490)).
