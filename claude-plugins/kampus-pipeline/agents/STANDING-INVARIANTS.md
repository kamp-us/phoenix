# Standing invariants — the shared block

The `## Standing invariants` section of a `claude-plugins/kampus-pipeline/agents/` definition is
mostly agent-specific. A few entries are not: they are **byte-identical** across two or more
definitions, and those live here once instead of being re-carried per file.

Each definition keeps the rule **named at the position its full text occupied** and cites the entry
here for the detail. That placement is load-bearing: these are rules an agent must *apply* at a
specific moment, not background it must merely know, so the cite has to fire where the paragraph
used to.

**Scope: the `kampus-pipeline` agent definitions only.** A sibling plugin's `agents/**` is
deliberately outside the control-plane boundary (founder ruling #3765) and does not read this
file; nothing here is a cross-plugin dependency.

<a id="sp"></a>

## §SP — the per-run scratch namespace

- **Every intermediate file you write lives under a per-run scratch namespace (§SP).** Never
  stash state in a fixed or work-item-keyed scratchpad path (`prref.txt`,
  `/tmp/verdict-$PR.md`), and never in the harness-provided scratchpad directory — that one is
  session-scoped and **shared across the concurrent runs of a session**, so a generic leaf name
  gets clobbered mid-run and reads back **another run's content with no error**: silent, and it
  routed a reviewer's `git diff` to the wrong PR's files, then wrote one reviewer's verdict body
  over another's (#3718).
  Prefer passing the value in-process and writing no file at all; when a file is genuinely
  needed, allocate the namespace with the verb and name every leaf under it:
  `RUN_SCRATCH="$(pipeline-cli scratchpad open --slug <skill>-<work-item>)" || exit 1`, and in
  every LATER Bash call re-derive it with `pipeline-cli scratchpad path --slug <same-slug>` —
  your shell state does not survive between Bash calls, so nothing you set carries over. The
  verb is fail-closed: a missing session id, a namespace another run owns, and one this run
  never opened are each a distinct non-zero exit, never a fallback to a shared path. Never park
  the path in another file to carry it across — that just moves the collision onto that file.
  The rule, the no-CLI fallback recipe, the single-Bash-call `mktemp` carve-out, and the
  never-leak-the-path corollary are single-sourced in the skills'
  `gh-issue-intake-formats.md` §SP.

<a id="rest"></a>

## §REST — the GitHub access path

- **All GitHub ops via `gh api` REST — never GraphQL.** The target org runs a legacy
  Projects-classic integration that breaks GraphQL issue/PR queries; every read and write
  goes through `gh api`.

<a id="root"></a>

## §ROOT — the working directory

- **Work from the repo root**, not a nested app directory.
