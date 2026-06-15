#!/usr/bin/env python3
"""Leak-guard PreToolUse hook (issue #173): block user-local filesystem paths from
entering SHARED artifacts at write time, instead of relying on per-skill prose to
remember to grep (the failure mode that shipped a vault path to main — see #158).

Wired on Write/Edit/MultiEdit. Reads the Claude Code PreToolUse JSON envelope from
stdin, decides whether the target is a shared-artifact doc surface, scans the text
being written for the #158 leak class, and DENIES the call (exit 0 + a deny decision
on stdout) when a real leak is present. A clean write is allowed silently.

LEAK SET (a committed home/local/vault path — the #158 regression class):
  - /Users/<name>/...        absolute macOS home path
  - a leading ~/             home-relative path (word-boundary, not mid-token)
  - ~/.claude, ~/.usirin, ~/.agent   agent/tool home dirs
  - ~/code/...               home-dir sibling-repo clones
  - /vault/ , vault-style sibling paths
These mirror the patterns the review-doc gate greps for (review-doc SKILL.md section 4)
and the report skill's footer-privacy contract — this hook is their write-time
enforcement.

ALLOWLIST (legitimate content that must NOT be flagged):
  - Repo-relative paths (apps/web/..., .claude/skills/..., packages/...) — never absolute.
  - Sanctioned ephemeral scratch: /tmp/... (e.g. /tmp/write-code-*.md,
    /tmp/review-*-verdict-*.md). /tmp is a leak only if it is a /Users//~ path; a bare
    /tmp path encodes no user identity or local layout, so it is allowed.
  - Documented product paths like ~/.config/... (the kampus CLI credential store) — a
    ~/.config reference is a documented runtime location, not a leak of *this* machine.
  - Path-hygiene docs that spell the pattern out as a *pattern* rather than commit it as
    a real path: this hook file, the review-doc/triage/report skills, and any file whose
    own subject is path hygiene. Such files are exempt by path (DOC_SELF_EXEMPT) because
    they must name the very tokens they forbid (review-doc SKILL.md section 4 carve-out).

SHARED-ARTIFACT SURFACES (where the guard fires): committed doc surfaces only —
*.md anywhere, plus .decisions/ and .patterns/. Arbitrary source (a TS string literal
containing /Users in a test fixture) is out of scope, matching the AC's "scope the match
to shared-artifact doc surfaces, not arbitrary source."

A PreToolUse hook cannot see gh issue/PR bodies (those are Bash invocations, not Write);
the review-doc gate + report footer contract remain the net for posted bodies. This hook
covers the committed-file half of "shared artifacts", which is the #158 leak class.
"""

import json
import re
import sys

# --- shared-artifact doc surfaces -------------------------------------------------
DOC_SUFFIXES = (".md", ".mdx", ".markdown")
DOC_DIRS = ("/.decisions/", "/.patterns/")

# Files whose subject IS path hygiene: they must spell the forbidden tokens out as
# patterns. Matched as a path suffix so it works for absolute or repo-relative targets.
DOC_SELF_EXEMPT = (
	"/.claude/hooks/leak-guard.py",
	"/.claude/skills/review-doc/SKILL.md",
	"/.claude/skills/triage/SKILL.md",
	"/.claude/skills/report/SKILL.md",
	"/.claude/skills/report/footer.sh",
)

# --- the leak patterns ------------------------------------------------------------
# Each entry: (compiled regex, human reason). Order = report order.
LEAK_PATTERNS = [
	(re.compile(r"/Users/[A-Za-z0-9._-]+"), "absolute macOS home path (/Users/<name>/...)"),
	(re.compile(r"(?<![\w.])~/\.(claude|usirin|agent)\b"), "agent/tool home dir (~/.claude, ~/.usirin, ~/.agent)"),
	(re.compile(r"(?<![\w.])~/code/"), "home-dir sibling-repo clone (~/code/...)"),
	(re.compile(r"(?<![\w/])/vault/"), "vault path (/vault/...)"),
	# A leading ~/ home path in general — but NOT ~/.config (documented product path,
	# e.g. the kampus CLI credential store) and NOT the dirs already named above.
	(re.compile(r"(?<![\w.])~/(?!\.config\b)"), "home-relative path (~/...)"),
]

# Allow a bare /tmp/ path: it carries no user identity or local layout. The /Users
# pattern above already never matches /tmp, so no extra carve-out is needed here —
# this comment documents the deliberate non-match.


def is_shared_artifact(path: str) -> bool:
	p = path.replace("\\", "/")
	if any(p.endswith(s) for s in DOC_SUFFIXES):
		return True
	return any(d in p for d in DOC_DIRS)


def is_self_exempt(path: str) -> bool:
	# Normalize to a leading slash so a relative `.claude/...` target matches the same
	# suffix as an absolute `/…/.claude/...` one (Write passes absolute, but be robust).
	p = "/" + path.replace("\\", "/").lstrip("/")
	return any(p.endswith(s) for s in DOC_SELF_EXEMPT)


def extract_target_text(tool_name: str, tool_input: dict):
	"""Return (file_path, text-being-written) for the supported tools, else (None, '')."""
	file_path = tool_input.get("file_path", "") or ""
	if tool_name == "Write":
		return file_path, tool_input.get("content", "") or ""
	if tool_name == "Edit":
		return file_path, tool_input.get("new_string", "") or ""
	if tool_name == "MultiEdit":
		edits = tool_input.get("edits", []) or []
		return file_path, "\n".join(str(e.get("new_string", "")) for e in edits)
	return None, ""


def find_leaks(text: str):
	"""Yield (matched_substring, reason) for every leak in text."""
	for pat, reason in LEAK_PATTERNS:
		for m in pat.finditer(text):
			yield m.group(0), reason


def deny(reason_lines):
	body = "Leak-guard blocked this write (issue #173): a user-local path may not enter a shared artifact.\n\n"
	body += "\n".join(reason_lines)
	body += (
		"\n\nUse a repo-relative path instead (apps/web/..., .claude/skills/...). "
		"If this is genuinely a documented pattern, not a real path, the surface may "
		"need to be added to DOC_SELF_EXEMPT in .claude/hooks/leak-guard.py."
	)
	out = {
		"hookSpecificOutput": {
			"hookEventName": "PreToolUse",
			"permissionDecision": "deny",
			"permissionDecisionReason": body,
		}
	}
	print(json.dumps(out))
	sys.exit(0)


def main():
	try:
		payload = json.load(sys.stdin)
	except (json.JSONDecodeError, ValueError):
		sys.exit(0)  # malformed envelope: never block on parse failure

	tool_name = payload.get("tool_name", "")
	tool_input = payload.get("tool_input", {}) or {}
	file_path, text = extract_target_text(tool_name, tool_input)

	if not file_path or not text:
		sys.exit(0)
	if not is_shared_artifact(file_path):
		sys.exit(0)
	if is_self_exempt(file_path):
		sys.exit(0)

	leaks = list(find_leaks(text))
	if not leaks:
		sys.exit(0)

	seen = set()
	lines = []
	for matched, reason in leaks:
		key = (matched, reason)
		if key in seen:
			continue
		seen.add(key)
		lines.append(f"  - `{matched}` — {reason}")
	deny(lines)


if __name__ == "__main__":
	main()
