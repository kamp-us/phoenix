# verify-extraction.sh check 1's invocation recognizer, in its own file so check 1 (the corpus scan)
# and check 1a (the recognizer self-test) run the SAME program — a self-test that certifies a copy
# certifies nothing.
#
# Reads one SKILL.md; prints one line per fenced bash/sh block that carries something other than a
# sanctioned non-glue shape, followed by the unrecognized lines. Silence means every block is clean.
# `-v skill=<name>` names the file in the output.
#
# The sanctioned shapes are epic #4435 / child #4454's AC4 list as recorded in the epic ledger, not a
# narrower guess: a skill-local script executed by path, a pipeline-cli verb call, the shim-resolution
# assignment that supplies one, an operator placeholder assignment, and a heredoc body fed to a
# recognized invocation. Widening the recognizer is the whole point of #4587 — the alternative (wrap
# every verb in a one-line script, hide the operator placeholders) removes zero glue and reduces
# legibility, which is what the epic exists to undo.
#
# Every shape is clamped by composes(): a recognized command that PIPES, CHAINS or `eval`s is glue
# again, whatever it invokes. That clamp is what keeps the widening from greening everything (#4587
# AC3) — without it a `gh … | grep … | "$PCLI" leak-guard scan-comment` scores as a verb call.

# a trailing ` # …` comment is prose. Strip it before matching so a mention of `$PCLI` or of a
# `skills/**.sh` path inside a comment cannot classify the CODE on that line. The strip needs
# whitespace on both sides of the `#`, so a `#` inside a ref/format string (`refs/#`, `"#$p"`)
# survives — the naive first-`#` strip the other checks use would eat those.
function decomment(l,   t) {
	t = l
	sub(/[[:space:]]#[[:space:]].*$/, "", t)
	return t
}

# true composition — two commands joined into a pipeline/chain — as opposed to a fail-closed `||`
# trailer on ONE command, which is a trimming every skill uses and which composes nothing.
function composes(l,   t) {
	t = l
	gsub(/\|\|/, "", t)
	return (index(t, "|") > 0 || index(t, "&&") > 0 || index(t, ";") > 0 || t ~ /(^|[[:space:]])eval([[:space:]]|$)/)
}

# does the line COMPOSE or SUBSTITUTE? the stricter clamp, for a bare assignment: an operator
# placeholder never needs a command to produce its value.
function computed(t) {
	return (composes(t) || index(t, "$(") > 0 || index(t, "`") > 0)
}

function classify(l,   c, t, u) {
	c = decomment(l)
	u = c
	gsub(/['"]/, "", u)
	# a skill-local script executed by path — anywhere under skills/<skill>/, not only scripts/
	# (report/footer.sh is a real helper, not glue, and the old regex could not see it)
	if (c ~ /skills\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.\/-]*\.sh/ && !composes(c)) return 1
	# a pipeline-cli verb call: the path-resolved shim, literal or through a resolved $PCLI, and
	# either run directly or captured. The skills MANDATE this shape (ADR 0207 — the shim is not on
	# PATH), so it can never be glue. Anchored: a verb name must follow the shim at the START of the
	# command, so a shim path buried mid-pipeline stays unrecognized.
	if (!composes(c) && (u ~ /^\$\{?PCLI\}?[[:space:]]+[a-z][a-z0-9-]*/ ||
	                     u ~ /^[^[:space:]]*bin\/pipeline-cli[[:space:]]+[a-z][a-z0-9-]*/ ||
	                     u ~ /^[A-Za-z_][A-Za-z0-9_]*=\$\([^)]*(\$\{?PCLI\}?|bin\/pipeline-cli)[[:space:]]+[a-z][a-z0-9-]*/)) return 1
	t = c
	# mask ${...} expansions: their :?/:- message text is prose, and its punctuation must not read
	# as shell composition (campaign's FOUNDER guard carries a `;` inside its refusal message)
	gsub(/\$\{[^}]*\}/, "$V", t)
	if (t ~ /^[A-Za-z_][A-Za-z0-9_]*=.*bin\/pipeline-cli['"]?$/) return 1   # the shim resolution itself
	# reads the UNMASKED `c` for the substitution, because the mask above deletes a `$( … )` NESTED
	# INSIDE an expansion — so `computed(t)` alone accepted `NUMS="${X:-$(gh api … | sort | head -5)}"`,
	# the wrapper rather than the pipeline deciding (#4587 repair round 1). Pinned by
	# `expansion-default-with-substitution` in check 1a.
	if (t ~ /^[A-Za-z_][A-Za-z0-9_]*=/ && !computed(t) && index(c, "$(") == 0 && index(c, "`") == 0) return 1
	return 0
}

function scanhd(l,   d) {   # arm heredoc-body skipping when this line opens one
	if (!match(l, /<<-?[[:space:]]*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/)) return
	if (RSTART > 1 && substr(l, RSTART - 1, 1) == "<") return   # a <<< herestring, not a heredoc
	d = substr(l, RSTART, RLENGTH)
	sub(/^<<-?[[:space:]]*/, "", d)
	gsub(/['"]/, "", d)
	hd = d
}

/^[[:space:]]*```(bash|sh)[[:space:]]*$/ { inb=1; start=NR; n=0; unc=0; solo_blocked=0; hd=""; cont=0; next }

inb && /^[[:space:]]*```[[:space:]]*$/ {
	# A block whose whole payload is ONE self-contained, uncomposed command composes nothing, so it
	# is not multi-line glue — the same `payload > 1` threshold AC4's pinned census uses (the
	# ADR-discovery `ls .decisions/NNNN-*.md` is the corpus instance). It is a threshold, not a
	# hole: a line that pipes/chains/substitutes still reds, and so does one that CONTINUES over a
	# `\`, which is a multi-line command wearing a single payload line's clothes.
	if (n == 0 || (unc > 0 && !(n == 1 && solo_blocked == 0))) {
		printf "%s:%d (payload lines=%d, unrecognized=%d)\n", skill, start, n, unc
		for (i = 1; i <= unc; i++) printf "    -> %s\n", offend[i]
	}
	inb=0; next
}

inb {
	line=$0
	sub(/^[[:space:]]+/, "", line)
	sub(/[[:space:]]+$/, "", line)
	if (hd != "") { if (line == hd) hd=""; next }   # heredoc body: an authored template, not shell
	if (line == "" || line ~ /^#/) next             # comments and blanks are not glue
	if (cont) { scanhd(line); cont = (line ~ /\\$/); next }   # a continuation of the counted line
	n++
	if (!classify(line)) { unc++; offend[unc]=line; if (computed(decomment(line)) || line ~ /\\$/) solo_blocked=1 }
	scanhd(line)
	cont = (line ~ /\\$/)
}
