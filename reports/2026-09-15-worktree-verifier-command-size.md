# Worktree verifier command-size pressure on stdin-bodied verbs

Measured for [#7335](https://github.com/kamp-us/phoenix/issues/7335). The harness isolation verifier
judges a worktree-isolated agent's whole command string, so a `fabrika review post` heredoc carrying
a long verdict is refused before the verb runs. The refusal text asserts a containment fault and
names no size, which is what makes a reviewer trim evidence instead of staging it.

## What was refused, and at what size

| Round | Harness | Body | Form | Outcome |
|---|---|---|---|---|
| PR #7321, `review-code` | — | ~9 KB | one heredoc | refused; posted after a cut to ~6 KB |
| PR #7681, `review-code` | — | ~11 KB | one heredoc | refused 3× on content, reached the verb at ~9 KB |
| PR #9179, `review-doc` | — | 11,161 bytes | one heredoc | refused |
| PR #9179, `review-doc` | — | 11,161 bytes | 5 bounded appends + literal redirect | posted and read back |
| lane 7335, first attempt | 2.1.267 | 11,177 bytes | 8 bounded appends + literal redirect | written and redirected; the post was refused by the auto-mode classifier, not the verifier |
| lane 7335, this run | 2.1.272 | 13,055 bytes | 5 bounded appends + literal redirect | written; redirect accepted and the bytes read on a verb's stdin |

The failing size is a band, not a line: the same body passes or fails on content at the same length.

## Trigger bisect at harness 2.1.272

Each row is one `cat >> <allocated path>` heredoc append, run from a worktree-isolated shell.

| Content of the append | Outcome |
|---|---|
| plain prose | accepted |
| a pipe-delimited table | accepted |
| blockquotes | accepted |
| angle brackets, generic-type syntax | accepted |
| possessive apostrophes | accepted |
| the version-control tool's three-letter name in prose | accepted |
| a brace group with commas and no quotes | accepted |
| a brace group holding double quotes, the shape a JSON object literal takes | **refused**, twice, at 60–120 bytes |
| the same brace group through a single-quoted `printf` | accepted |

So the quoted brace group is the one recorded trigger that survives inside a bounded append, and it
fires at any size. The tool-name trigger recorded on the issue in September did not reproduce here;
either it was fixed between 2.1.267 and 2.1.272 or it is conditional on something this run did not
carry. Both facts are on one host and one harness version, like every earlier measurement of this
verifier.

## The route that holds

Allocate with the group's scratch verb, write the body in bounded appends naming the literal path,
run the verb with a literal input redirect. It is fixed once for every group in
`claude-plugins/fabrika/docs/skill-conventions.md` §4, with the review-specific fence in that
skill's `SKILL.md` §7 and `contract.md`. No verb grows a path-valued body flag: the shell reads the
staged file, the verb still reads stdin, and every stdin refusal it makes still fires.

## What this run could not measure

A build lane may not post a review verdict — on another PR the harness classifier refuses it, and on
its own PR it would write a SHA-bound marker the ship gate reads. So the post-and-read-back leg of
the fourth acceptance criterion is taken by PR #9233's own worktree-isolated reviewer, which emits a
real verdict through this route and records its harness version and body byte count there. The write
and redirect legs are the two measured above.
