# taste-skill library — conventions

The shared contract every `taste-*` skill in this directory follows. A taste skill is the
factory's per-aspect creation guidance: strict generative rules with the *why* attached, loaded
by name into an existing coder/planner spawn when it creates UI (ADR
[0209](https://github.com/kamp-us/phoenix/blob/main/.decisions/0209-taste-voice-per-aspect-skills.md);
the noun is defined in [`.glossary/TERMS.md`](https://github.com/kamp-us/phoenix/blob/main/.glossary/TERMS.md)).

Read this before authoring or editing any `taste-*` skill. It is a **conventions contract, not a
skill** — it has no frontmatter and the harness never routes to it.

## 1. Grounding — exactly three artifacts, and there is no fourth

Every rule in a taste skill traces to one of these, or it is not law:

| Artifact | What it supplies | ADR |
|---|---|---|
| [`design-system-manifest.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-manifest.md) | The four pillars, the prohibitions, the role-token annotations, the v1 design values, the nav-IA law | [0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md) |
| [`design-system-inventory.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-inventory.md) | Which primitives exist, their slots, each one's when-to-use | [0194](https://github.com/kamp-us/phoenix/blob/main/.decisions/0194-design-law-jsdoc-firewall.md) |
| The blessed goldens | The visual reference a surface is measured against (bytes in depo, current-golden pointer in git) | [0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md) |

**Never add a fourth grounding artifact.** No taste skill mints a parallel design doc, a
"taste manifest", or a values file that claims normative weight. The one values file a taste
skill may own is a `STANDARDS.md` (§4) — and a `STANDARDS.md` is a *citation surface for craft
defaults*, explicitly not law.

## 2. The firewall — skills advise creation, they never author law

ADR 0194 draws a hard boundary: an agent may write the **descriptive** half of the design docs
and may **cite** the normative half, but only the founder writes design law. A taste skill sits
entirely on the advisory side of that line.

**The two-tier provenance rule — tag every rule LAW or CRAFT.** This is the mechanism that keeps
the firewall checkable rather than aspirational:

- **LAW** — the rule is transcribed from, or cited to, one of the three grounding artifacts.
  Write it as binding, and **name the exact section** it comes from (`Pillar 4 — Accessibility`,
  `v1 design value 4 — Tap target`). A LAW rule is never softened, re-worded into a new
  threshold, or extended by inference.
- **CRAFT** — an adopted or repo-grown advisory default: a good starting value where the law is
  silent. Write it as a default, never as a prohibition, and mark it. **CRAFT always yields to
  LAW.** When the two conflict, the skill states the conflict and follows LAW.

**Where the law is silent, say so and surface the gap — never fill it.** This is the manifest's
own closing rule, inherited. A taste skill that finds no law for a decision says *"the design law
is silent here; this is a CRAFT default"* and, when the gap is load-bearing, tells the agent to
file it via the [`report`](report/SKILL.md) skill. It never promotes its own default into a
prohibition, and it never edits `design-system-manifest.md`.

**Taste skills lag the law, never lead it.** When an ADR ratifies new law and it is transcribed
into the manifest, the taste skills citing the changed rule follow in a later PR.

## 3. Naming and layout

```
claude-plugins/kampus-pipeline/skills/
  taste-library-conventions.md        this file
  taste-library-notice.md             third-party license notices for adopted material
  taste-<aspect>/SKILL.md             one skill per aspect (color, layout, iconography, …)
  taste-<aspect>/STANDARDS.md         optional, values-only (§4)
  taste-<aspect>-<mode>/SKILL.md      when one aspect needs several modes
  taste-<aspect>-<mode>/STANDARDS.md  a mode-split aspect's one values file, on its owner (§4)
```

- **`taste-<aspect>`** is the default: one skill per design aspect. `taste-color`,
  `taste-layout`, `taste-iconography`, `taste-forms`, `taste-copy`.
- **`taste-<aspect>-<mode>`** when an aspect genuinely needs more than one procedure — the
  animation cluster is the worked example (`taste-animation-review`,
  `taste-animation-improve`, `taste-animation-opportunities`, `taste-animation-vocabulary`).
  Split by *mode*, never by topic: a second skill must run a different procedure, not restate the
  same rules for a sub-topic.
- The dir name **is** the frontmatter `name` — [`validate-skills.sh`](validate-skills.sh) fails
  the build otherwise. The dir name is also the citation surface plans and pitches use, so treat
  it as a stable public name.

**No `.sh` file, anywhere under a `taste-*` dir — this is a hard boundary, not a style rule.**
`CODEOWNERS` owns `claude-plugins/kampus-pipeline/skills/**/*.sh`, so a single shell script
converts an otherwise ordinary PR into a control-plane PR that cannot auto-merge and waits on a
human. Nothing warns you at authoring time. A taste skill that needs a deterministic check calls
an existing `pipeline-cli` subcommand; if you believe a script is genuinely required, stop and
raise it as a scope decision. Verify before opening the PR:

```bash
# proven-ordinary ⇒ exit 3. control-plane ⇒ exit 0 ⇒ something under your diff is owned; find it.
bash ./claude-plugins/kampus-pipeline/skills/shared/scripts/cp-classify-working-diff.sh
```

## 4. The SKILL.md / STANDARDS.md split

- **`SKILL.md` carries rules, procedure, and output shape.** Decision tables, flowcharts, the
  gate a candidate must pass, the format the skill must emit. It states *what to do and why*.
- **`STANDARDS.md` carries values only.** Durations, easings, thresholds, spring configs, token
  names — the exact figures a skill cites *instead of approximating*, one per table row, each
  carrying its provenance tag (LAW + section, or CRAFT). No procedure, no verdict language, and no
  rule that the table above it does not already state.

  **Two prose forms are permitted, and only these two.** Both attach to a table and neither
  introduces a rule:

  - **A provenance gloss** — a sentence or two under a table stating the boundary its tag already
    implies: what a LAW row actually binds, or which law a block of CRAFT rows serves. *"A
    press-feedback scale shrinks the painted glyph, never the hit area: `--tap-min` is a
    density-invariant floor."* The test is subtractive — delete the gloss and no value in the table
    changes meaning.
  - **A `Known divergence (surface, do not resolve locally)` note** — §2's mandated disclosure when
    an adopted craft value conflicts with the value the repo ships. The firewall *requires* the
    conflict be stated and not resolved, so this note is not optional prose.

  Anything longer than that is a rule, and a rule lives in `SKILL.md`.

**One `STANDARDS.md` per aspect, and exactly one file owns it.** Sibling skills link to it; they
never copy values into their own file. A duplicated value is a value that drifts.

**Which file owns it follows the aspect's shape (§3), and both shapes are legitimate:**

- **A single-skill aspect** owns its values at `taste-<aspect>/STANDARDS.md` — the aspect has one
  skill, so there is nothing to disambiguate.
- **A mode-split aspect** has no `taste-<aspect>/` directory to hold the file, so the owner is the
  **mode that grades against the figures** — the review mode where one exists, otherwise the mode
  whose procedure cites the most rows. The file lives in that mode's own directory and the sibling
  modes link across into it. The animation cluster is the worked example:
  [`taste-animation-review/STANDARDS.md`](taste-animation-review/STANDARDS.md) is the animation
  aspect's single values file, and `taste-animation-improve` and `taste-animation-opportunities`
  cite it there. **Never mint a `taste-<aspect>/` directory just to home the file** — a directory
  holding a `STANDARDS.md` and no `SKILL.md` is a shape the library does not have and
  [`validate-skills.sh`](validate-skills.sh) has never been checked against.

A `STANDARDS.md` is optional — add one when the aspect has enough concrete figures that a skill
would otherwise guess at them.

## 5. The rule shape

Every rule is **imperative + concrete value + one-line why + named counterexample**. All four
parts, every time. The counterexample is what makes a rule checkable — it names the wrong thing
specifically enough that an agent recognizes its own output in it.

> **Never animate a keyboard-initiated action.** (CRAFT) Command palettes, shortcuts, and
> focus jumps fire hundreds of times a day; motion makes a fast action feel slow.
> *Counterexample: a 200ms scale-in on the `⌘K` palette.*

**A rule that spans both tiers — the compound tag `(CRAFT, serving LAW — <section>)`.** §2's two
tiers are binary per *rule*, and a real rule sometimes sits in both: a craft default whose whole
purpose is to serve a law. Tag it compound — craft-tiered (it yields on conflict, and it is written
as a default, never a prohibition), with the law it serves named so an author can see what is
actually at stake behind the default:

> **Animate `transform` and `opacity` only.** (CRAFT, serving LAW — Pillar 1) Layout properties
> force layout and paint on every frame.
> *Counterexample: `transition: height 200ms` on an expanding comment thread.*

**Never flatten a mixed bundle to one tag.** A numbered standard that bundles several clauses tags
each clause it holds — inline, where the clause sits — whenever they are not all the same tier. A
CRAFT clause riding under a `(LAW)` heading reads as binding, which is the single failure the
two-tier rule exists to prevent, and it is invisible at authoring time. When inline tagging gets
crowded, that is the signal to split the bundle into two rules.

Rules that admit a threshold go in a **decision table** with hard boundaries — no "usually",
"consider", or "as appropriate":

| Condition | Decision |
|---|---|
| 100+ times/day | No animation. Ever. |
| Occasional (modals, drawers, toasts) | Standard animation |

Multi-step judgments go in a **text flowchart** — a numbered gate where each step has a stated
verdict, so the call is mechanical rather than a taste guess.

## 6. The mandated output shape (review-mode skills)

A skill that *reviews* something emits two parts, in this order — no other shape:

1. **A findings table.** One row per finding, columns `Before | After | Why`. A single table,
   never a prose list of before/after pairs.
2. **A verdict.** Remaining commentary grouped by impact tier, highest first, empty tiers
   omitted, closing with an explicit **Block** or **Approve** and the criteria for each.

Cite `file:line` in every finding. Pull exact values from the aspect's `STANDARDS.md` rather than
approximating.

**A taste skill's verdict is advice, never a pipeline gate.** It does not post a
`review-(code|doc|skill|design)` marker and it never substitutes for `review-design`.

## 7. Attribution for adopted material

Material adopted from a third party carries an **Attribution** section at the bottom of its
`SKILL.md`, naming the source, its license, what was adapted, and pointing at
[`taste-library-notice.md`](taste-library-notice.md) for the verbatim license text. Copy this
block and fill it in:

```markdown
## Attribution

Adapted from [`<owner>/<repo>`](https://github.com/<owner>/<repo>) (MIT, © <year> <author>) —
`<upstream file(s)>`. Adapted for phoenix: <the substantive changes>. Full license text:
[`taste-library-notice.md`](../taste-library-notice.md).
```

**Strip promotional material from adopted text.** Upstream skills funnel to their author's paid
course; the adaptation keeps the craft and drops the funnel — no course links, no newsletter
links, no product plugs. Attribution to the source repository is the whole of what is retained.

## 8. Checklist for a phase-2 sibling author

Before you open the PR:

- [ ] Dir is `taste-<aspect>/` (or `taste-<aspect>-<mode>/`) under
      `claude-plugins/kampus-pipeline/skills/`, and frontmatter `name` matches the dir.
- [ ] `description` states what the skill is **and** the situations it fires on — it is the
      routing surface, not a summary.
- [ ] The SKILL.md opens with a **Grounding and firewall** section that names all three artifacts
      (§1) in full, each as an absolute `blob/main` URL — a skill loads standalone into a spawn
      that may never open this contract, and the three artifacts live outside this plugin, so a
      repo-relative path to them does not resolve.
- [ ] That section **cites §2 for the firewall — it does not restate it.** Restating it is what
      forked the rule across the first four skills, each in its own wording. Point at §2 (a
      sibling of your dir, so a relative link resolves) and add at most one skill-specific
      sentence saying what LAW/CRAFT means for *this* skill's own output shape.
- [ ] Every rule is tagged **LAW** (with its manifest section), **CRAFT**, or the compound
      **CRAFT, serving LAW — `<section>`** (§5); a standard bundling clauses of different tiers
      tags each clause inline rather than flattening to one; no CRAFT rule is written as a
      prohibition.
- [ ] Rules follow the four-part shape (§5); thresholds live in decision tables.
- [ ] Values live in `STANDARDS.md` if the aspect has one, and are cited, not copied.
- [ ] Adopted material carries the Attribution block (§7) with promotional links stripped.
- [ ] Zero `.sh` files under the dir; `cp-classify` says proven-ordinary (§3).
- [ ] No home-directory, absolute, or sibling-repo paths in any file — repo-relative only.
