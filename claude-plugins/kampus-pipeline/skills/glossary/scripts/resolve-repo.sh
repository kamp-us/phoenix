#!/usr/bin/env bash
# Print the target repo as `owner/name` (§Target repo resolution, ADR 0062 §1).
# Extracted from glossary/SKILL.md (#4454, epic #4435 phase 1).
set -uo pipefail
# shellcheck source=../../../lib/common.sh disable=SC1007,SC1091
. "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../lib" && pwd)/common.sh"

kp_repo
