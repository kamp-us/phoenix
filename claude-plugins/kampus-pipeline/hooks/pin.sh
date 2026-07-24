#!/usr/bin/env bash
# The @kampus/pipeline-cli version pin for the hook layer, sourced by BOTH install.sh
# (what it installs) and guard.sh (what it refuses to dispatch below).
#
# The pin lives in its own sourceable file because guard.sh has to SEE it: a wrapper that
# cannot read the pin can only test executability, and an executability test cannot tell a
# current build from a months-old one. That is how the unpublished 0.2.0 pin let every guard
# hook silently dispatch the stale 0.1.0 tree — a build predating ADR 0172 with zero copies
# of the isolation guard — for months (#3742).
#
# Bumping this reinstalls on the next SessionStart. The bump only takes effect once the
# matching version is actually PUBLISHED: cut a `pipeline-cli-v<version>` GitHub Release,
# which is what .github/workflows/publish.yml publishes from. Until then install.sh cannot
# install it and guard.sh refuses to dispatch anything else.
#
# This is the ONE pin home. The skills carry no copy of it: they invoke the `bin/pipeline-cli`
# shim, which sources THIS file for its dlx fallback (#3653, per #3457). The package's own
# package.json / src/version.ts version is test-locked equal to this pin by
# pin-dispatch.hook.test.ts — the same value, not a second source to hand-sync.

KAMPUS_PIPELINE_CLI_PKG="@kampus/pipeline-cli"
KAMPUS_PIPELINE_CLI_PIN="0.2.1"
