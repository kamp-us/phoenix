# phoenix

kamp.us, reborn. Each runnable app lives under `apps/`; shared packages live under
`packages/`; standalone stacks live under `infra/`. Deployed apps own their stack
and stage. Local apps have no `alchemy.run.ts` and never deploy.

## Working rules

- Use `pnpm`, including `pnpm dlx` instead of `npx`. Commands and formatting are
  declared in the owning `package.json` and root Biome config.
- Dependencies use `catalog:` or `workspace:`. Read the owning manifest,
  [workspace catalogs and overrides](pnpm-workspace.yaml), and resolved lockfile
  before changing a dependency. A named catalog does not isolate transitive
  dependencies: preserve parent-scoped overrides and check crossed lockfile edges.
  Catalog a transitive dependency at the exact version its existing parent uses.
- Make invalid states unrepresentable. Domain logic belongs in domain objects.
- Repository tooling uses Node and Effect CLI, with a testable decision core and a
  thin bin. Existing shell relays tool results; it does not own those decisions.
- Verify claims about platform and dependency behavior in authoritative source
  or a real test, and cite the evidence. For Effect, start with upstream
  [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md) and its examples;
  verify APIs against the consumer's actual pin where main differs. A departure
  from a documented idiom needs a real platform constraint, not preference.
- Product decisions lead by default; engineering leads platform and infrastructure
  choices ([ADR 0078](.decisions/0078-product-driven-decisions-by-default.md)).
- Product and brand names stay Turkish; technical identifiers and prose are English.
  Use the relevant definitions in [.glossary/LANGUAGE.md](.glossary/LANGUAGE.md)
  and [.glossary/TERMS.md](.glossary/TERMS.md) when naming or changing a concept.
- Comments explain a local invariant or constraint the code cannot express. Keep
  rationale in decisions and reusable implementation guidance in patterns. Apply
  [deslop-comments](claude-plugins/fabrika/skills/deslop-comments/SKILL.md) when
  reviewing comment noise.
- Follow applicable Fabrika skills when using Fabrika. Discover the current skills
  through the installed catalog or [skill directories](claude-plugins/fabrika/skills/).
  File deferred work through [report](claude-plugins/fabrika/skills/report/SKILL.md)
  when it is found, unless the task explicitly excludes filing.

## Discover the context for the task

Read the owning directory's `AGENTS.md` and the nearest working code and tests.
[.patterns/index.md](.patterns/index.md) is the one task-to-pattern map; read the
rows relevant to the change, not every linked document. Add or extend a pattern
only when it meets that index's admission rules.

Verify current behavior in source. Check the governing decision before treating a
difference between source and guidance as intended design.

| Home | Owns |
|---|---|
| [README.md](README.md) | Product introduction and ethos |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Setup, commands and current development state |
| [design-system-manifest.md](design-system-manifest.md) | Rendered UI design law |
| [.patterns/](.patterns/index.md) | Current implementation guidance and when to read it |
| [.glossary/](.glossary/LANGUAGE.md) | Canonical terms and necessary distinctions |
| [.decisions/](.decisions/) | Decisions, rationale and history |
| [reports/](reports/) | Dated findings and measurements |

Use resolvable Markdown links. Keep each fact in its owning document and link to it.

## Decision discovery

List `.decisions/`: filenames identify records, and each record's frontmatter gives
its `id`, `title` and `status`. Read applicable records when changing the choice they
govern or resolving conflicting guidance. Record new decisions with `/adr`.

There is no committed ADR index, startup map hook, or `fabrika` compact-map command.
Filenames plus frontmatter are the discovery contract
([ADR 0129](.decisions/0129-adr-discovery-is-the-claude-md-contract.md), amended by
[ADR 0305](.decisions/0305-v1-cli-deletion-retires-three-git-boundary-guards.md)).
