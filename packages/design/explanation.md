# Why `@kampus/design` is shared

`@kampus/design` is the repository's shared home for the Kampüs browser primitives, their token and font entry points, and their accessibility contract.

`apps/web` consumes the shared implementation today; the planned Tuval browser surface can add the package as a future consumer instead of copying primitives or reaching across application boundaries. Issue [#7561](https://github.com/kamp-us/phoenix/issues/7561) records the ownership move from `apps/web`; the move keeps the existing component contracts and rendered surface intact while making the design law portable to another consumer.

The package owns React component code and the CSS entries. React and React DOM remain peer dependencies because each consuming application supplies its own React runtime. `AgentChatInput` is the deliberate boundary case: the component is shared, while the Pi transport remains app-owned and crosses the boundary through `AgentChatInputBridge`.

The four-pillars design law remains the governing context: [ADR 0162](../../.decisions/0162-four-pillars-design-law.md) defines the design obligations, and [ADR 0194](../../.decisions/0194-design-law-jsdoc-firewall.md) keeps the generated inventory descriptive rather than normative.
