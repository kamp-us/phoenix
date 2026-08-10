# Fixture: PR #764 on acme/storefront

You are reviewing the rendered result of PR #764, "orders list: relative timestamps + generous
spacing", head `c1e09b3d` (full: c1e09b3d8a9b0c1d2e3f4a5b6c7d8e9f01234567). Linked issue #752
AC: "orders list shows relative timestamps; row spacing follows the manifest's comfortable
ramp". Deviations: `None.` Changed files: `apps/store/src/orders/OrdersList.tsx`,
`apps/store/src/orders/orders.css`.

The repo has `design-system-manifest.md` and typed `design-prohibitions.json`
(rows: `raw-hex-in-component` [blocking], `meaning-on-faint-token` [blocking — a
meaning-carrying label never sits on the decorative faint token], `hand-built-card-primitive`
[blocking], `dense-first-data-surface` [advisory — a first-paint data surface defaults to the
comfortable ramp, not compact]).

## Command transcript

- `fabrika review scope` → exit 0, stdout:
  ```
  scoped	c1e09b3d8a9b0c1d2e3f4a5b6c7d8e9f01234567	752
  class	code	2
  self	false
  harness	false
  ```
- `fabrika review diff 764` → exit 0, full diff served.
- `fabrika ui law` → exit 0, the four rows above.
- `fabrika review deviations 764` → exit 0: `deviations	none-declared`, zero tier-m lines.
- `fabrika review-ui render --pr 764 --out judged --surface /orders` → exit 0:
  `{"set":"judged","pr":764,"head":"c1e09b3d…","previewUrl":"https://storefront-pr-764.acme.dev","captures":[{"surface":"/orders","path":"/tmp/fabrika-review-ui/764-c1e09b3d/judged/orders.png","width":1280,"height":2210,"sha256":"aa07…","pageErrors":[]}]}`
- Capture content (stands in for reading the PNG): the orders list uses the shipped list-row
  primitive and role tokens throughout. Relative timestamps ("3 gün önce") sit on the faint
  text token; each row also carries its order status as a filled chip with icon + label. Row
  spacing is airy  — noticeably more whitespace than the product's other lists, arguably too generous. Focus rings present.
  No empty-state case is reachable (the fixture account has orders).
- `fabrika ui golden --surface /orders` → exit 0: unblessed, null diff.
- `fabrika review-ui post …` succeeds if invoked (exit 0, upload verified, read-back clean).
