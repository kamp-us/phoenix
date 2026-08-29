# Running fabrika in a repo

Recipes for getting `fabrika` installed, credentialed and answering in the repo you are standing in.
Each recipe below is independent — start at the one whose result you want.

Facts about individual verbs — what a group does, what each exit code means — live in the
[verb reference](../README.md).

## Install the CLI and confirm it runs

1. Install it globally:

   ```bash
   pnpm add --global @kampus/fabrika-cli
   ```

2. Confirm the binary starts:

   ```bash
   fabrika --version
   ```

   It prints `fabrika v<version>` on stdout and exits `0`. Exit `127` with no `fabrika` line means
   the shell found no binary — the install did not land.

Inside a phoenix checkout you can skip the install and run the working tree directly:

```bash
node packages/fabrika-cli/src/bin.ts --version
```

## Give it a GitHub credential and confirm a GitHub-touching verb works

1. Put a token in the environment, as `GITHUB_TOKEN` or `GH_TOKEN`:

   ```bash
   export GITHUB_TOKEN=<your token>
   ```

   On a developer machine with `gh` already logged in you can skip this step — the credential is
   resolved from that login once at startup. The resolution order and why `gh` is a convenience
   rather than a prerequisite are in
   [ADR 0315](../../../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md).

2. Run a verb that reads GitHub:

   ```bash
   fabrika status board
   ```

   A working credential prints a scope line on stderr and one `board` row plus one `bucket` row per
   counted bucket on stdout:

   ```text
   status board: scanned 594 items; counted 6 buckets over kamp-us/phoenix, 0 unknown (-).
   board	counted	6
   bucket	needs-triage	3	labels=status:needs-triage	-	2026-08-29T21:41:07Z
   ```

   With no credential anywhere it refuses instead, naming both variables:

   ```text
   no GitHub token — set GITHUB_TOKEN or GH_TOKEN (on a developer machine, `gh auth login` also resolves one)
   ```

## Confirm which copy of the CLI served the invocation

1. From the checkout or worktree in question, re-run any invocation with `FABRIKA_DEBUG=1`:

   ```bash
   FABRIKA_DEBUG=1 fabrika --version
   ```

2. Read the one extra stderr line. It names the copy that served the run — from a phoenix worktree:

   ```text
   fabrika: global at /…/phoenix/packages/fabrika-cli — delegating to the repo-local install at /…/phoenix/.claude/worktrees/agent-1234/packages/fabrika-cli (…/src/bin.ts, v0.5.0)
   ```

   A `running here` line instead means the copy you invoked is the one answering, with no delegation.
   A `refusing` line means the copy lives in a different repository from your working directory, and
   the run exits `126`; pass `--skip-infer` to make that copy serve it anyway. The boundary these
   three lines report is [ADR 0287](../../../.decisions/0287-delegation-stays-inside-one-repository.md).

## Run from a consumer repo that pinned a version

1. Add the CLI to that repo and install it:

   ```bash
   pnpm add --save-dev @kampus/fabrika-cli
   ```

   From then on `fabrika` inside that repo runs the pinned copy, not the global.

2. If you meant to run the global — the repo has no install yet, or you are deliberately on a newer
   copy — the run warns on stderr and names both versions:

   ```text
   fabrika: running the GLOBAL install (v0.5.0) — /…/consumer has no local install.
     /…/consumer/package.json declares @kampus/fabrika-cli ^0.4.0; install it to run the version this repo pins.
     Silence this with FABRIKA_GLOBAL_WARNING_DISABLED=1.
   ```

3. When running the global is what you want, silence the warning for that invocation:

   ```bash
   FABRIKA_GLOBAL_WARNING_DISABLED=1 fabrika status board
   ```

## Find a group and a verb without reading source

1. List the registered groups:

   ```bash
   fabrika --help
   ```

2. List one group's verbs, each with a one-line description:

   ```bash
   fabrika adr --help
   ```

3. Read one verb's flags, its exit codes and a worked example:

   ```bash
   fabrika adr next --help
   ```

   Its `DESCRIPTION` block carries the exit codes that verb can produce and an `Example:` line you
   can run as written.

## Read a refusal

1. Check the exit status before reading any output:

   ```bash
   fabrika adr next --dir .decisions-nope
   echo $?
   ```

   ```text
   adr next: cannot read .decisions-nope at origin/main: fatal: Not a valid object name … — the merged set is UNKNOWN, never "0 records".
   11
   ```

2. Look `11` up in the [verb reference](../README.md) — its shared exit table covers `3`–`11`, and
   each group's own section lists the codes that group adds on top.

3. Take the non-zero exit as UNKNOWN and re-run or stop. Do not read the empty stdout as "nothing
   found": a verb that found nothing prints a token for it, as `absent` at exit `0`.
