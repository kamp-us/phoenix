#!/usr/bin/env bash
# Validate every skills/*/SKILL.md beside this script opens with YAML frontmatter carrying
# a non-empty `name` and `description`, and that `name` matches its directory. The
# `description` is what the harness routes on, so a malformed one silently makes a
# skill unroutable — this guard fails the build instead. Run locally or from CI
# (see .github/workflows/ci.yml). Issue #239.
set -euo pipefail

# This script lives in the skills root, so its own dir IS that root — resolve from BASH_SOURCE
# so it works from any cwd (local shell or CI runner), PHYSICALLY (`-P`) so a symlinked or
# relative caller still lands on the real directory the walk below climbs out of.
skills_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Repo-relative prefix for every path this guard prints: a FAIL has to name a path the reader
# can open. Climb to the repo root (`.git` is a dir in a clone, a file in a worktree) and strip
# it; with no root above us, print the bare directory name rather than a checkout-absolute path.
repo_root="$skills_dir"
while [ "$repo_root" != "/" ] && [ ! -e "$repo_root/.git" ]; do
	repo_root="$(dirname "$repo_root")"
done
if [ -e "$repo_root/.git" ]; then
	rel_root="${skills_dir#"$repo_root"/}"
else
	rel_root="$(basename "$skills_dir")"
fi

shopt -s nullglob
errors=0
count=0

strip() { # trim surrounding whitespace then surrounding quotes
	local s="$1"
	s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
	s="${s#[\"\']}"; s="${s%[\"\']}"
	printf '%s' "$s"
}

for skill_md in "$skills_dir"/*/SKILL.md; do
	count=$((count + 1))
	rel="$rel_root/${skill_md#"$skills_dir"/}"
	dir_name="$(basename "$(dirname "$skill_md")")"

	if [ "$(head -n1 "$skill_md")" != "---" ]; then
		echo "FAIL $rel: missing opening '---' frontmatter fence on line 1"
		errors=$((errors + 1))
		continue
	fi

	# frontmatter = lines between the first two '---' fences
	frontmatter="$(awk 'NR==1{next} /^---[[:space:]]*$/{exit} {print}' "$skill_md")"
	if [ -z "$frontmatter" ]; then
		echo "FAIL $rel: empty or unterminated frontmatter block"
		errors=$((errors + 1))
		continue
	fi

	name="$(strip "$(printf '%s\n' "$frontmatter" | sed -n 's/^name:[[:space:]]*//p' | head -n1)")"
	desc="$(strip "$(printf '%s\n' "$frontmatter" | sed -n 's/^description:[[:space:]]*//p' | head -n1)")"

	if [ -z "$name" ]; then
		echo "FAIL $rel: frontmatter missing non-empty 'name'"
		errors=$((errors + 1))
	elif [ "$name" != "$dir_name" ]; then
		echo "FAIL $rel: name '$name' does not match directory '$dir_name'"
		errors=$((errors + 1))
	fi

	if [ -z "$desc" ]; then
		echo "FAIL $rel: frontmatter missing non-empty 'description'"
		errors=$((errors + 1))
	fi
done

if [ "$count" -eq 0 ]; then
	echo "FAIL: no $rel_root/*/SKILL.md found (run from the repo, or check the path)"
	exit 1
fi

if [ "$errors" -gt 0 ]; then
	echo "validate-skills: FAILED — $errors error(s) across $count skill(s)"
	exit 1
fi

echo "validate-skills: OK — $count skills valid"
