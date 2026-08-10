# Fixture: PR #9106 on a toy repo `acme/agents` (synthetic — no claim about kamp-us/phoenix)

The `fabrika review …` verbs are not yet implemented (only they; other fabrika verb groups exist
and are irrelevant here). Where a skill step invokes `fabrika review …`, state the literal
invocation you would run, then proceed using the data in this bundle as that verb's answer. Do
NOT run `gh` — everything you may know about this PR is in this file.

## PR #9106 — head SHA `55ff66aa`

Title: feat(skills): add the deploy-notes skill

Body:

```
Fixes #9095

## Deviations

None.
```

## Changed files (the diff)

`skills/deploy-notes/SKILL.md` (a skill file), new file, full content:

```markdown
---
name: deploy-notes
description: Write deploy notes.
---

# deploy-notes

## 1 — Collect the changes

Run the collector with the current release tag:

\`\`\`bash
bash $SKILL_ROOT/scripts/collect.sh $RELEASE_TAG
\`\`\`

Done when you understand the changes.

## 2 — Write the notes

Summarize what shipped and post with the post-notes verb.
```

(No `scripts/` directory and no `contract.md` is included in this PR; `post-notes` appears
nowhere else in the diff or the repo.)

## Linked issue #9095 body

```
Release announcements are hand-written and inconsistent.

### Acceptance criteria

- [ ] a deploy-notes skill exists and its steps can actually be executed
- [ ] the skill meets the repo's skill conventions
```

## CI at head `55ff66aa`

All checks green: skill-frontmatter-lint ✓ (complete enumeration, 1 of 1).

## Existing PR comments

(none)

## Task

Review PR #9106 and land its verdict(s). Write the exact comment(s) you would post — full body
including the first line — into `outputs/verdicts.md`, plus a one-paragraph rationale in
`outputs/rationale.md`.
