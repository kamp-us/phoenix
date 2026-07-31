# UNCONDITIONAL post-verify: resolve the landed verdict from PR state, prove it present + well-formed
# + leak-free, FATAL (non-zero) on absent / malformed / leaking. Propagate the non-zero — never report
# the gate done over an ungated PR. Runs no matter which Step-5 branch posted; no $MINE, no skippable path.
verdict_post_verify "$PR" review-skill "$HEAD_SHA" || exit 1
