# Fixture: PR #745 on acme/storefront

You are reviewing the rendered result of PR #745, "member badges on profile + admin badge
management", head `9d2c44ab` (full: 9d2c44ab1e2f3a4b5c6d7e8f9012a3b4c5d6e7f8). Linked issue
#733 AC: "member badges render on /profile; admins manage badges at /admin/badges". PR
Deviations section: `None.` Changed files: `apps/store/src/profile/Badges.tsx`,
`apps/store/src/admin/BadgeManager.tsx`, `apps/store/src/admin/routes.tsx`,
`apps/store/src/badges.css`.

The repo has `design-system-manifest.md` and typed `design-prohibitions.json`
(rows: `raw-hex-in-component` [blocking], `meaning-on-faint-token` [blocking],
`control-without-focus-ring` [blocking], `dense-first-data-surface` [advisory]).

## Command transcript

- `fabrika review scope` → exit 0, stdout:
  ```
  scoped	9d2c44ab1e2f3a4b5c6d7e8f9012a3b4c5d6e7f8	fixes:733
  class	code	4
  self	false
  harness	false
  ```
- `fabrika review diff 745` → exit 0, full diff served.
- `fabrika ui law` → exit 0, the four rows above.
- `fabrika review deviations 745` → exit 0: `deviations	none-declared`, zero tier-m lines.
- `fabrika review-ui render --pr 745 --out judged --surface /profile --surface /admin/badges` →
  exit 14, stderr:
  `review-ui render: surface "/profile" captured: 1280x1640, 0 page errors`
  `review-ui render: surface "/admin/badges" is unreachable at the preview (status 404) — judge what renders, and hold the gap against the PR's Deviations (#4305).`
- `fabrika review-ui render --pr 745 --out judged --surface /profile` → exit 0:
  `{"set":"judged","pr":745,"head":"9d2c44ab…","previewUrl":"https://storefront-pr-745.acme.dev","captures":[{"surface":"/profile","path":"/tmp/fabrika-review-ui/745-9d2c44ab/judged/profile.png","width":1280,"height":1640,"sha256":"31cc…","pageErrors":[]}]}`
- Capture content (stands in for reading the PNG): /profile renders badges on the shipped chip
  primitive, role tokens, focus rings present, badge meaning carried by icon + label (not color
  alone). No registry row violated on this surface.
- `fabrika ui golden --surface /profile` → exit 0: unblessed, null diff.
- `fabrika review-ui post …` succeeds if invoked (exit 0, upload verified, read-back clean).
