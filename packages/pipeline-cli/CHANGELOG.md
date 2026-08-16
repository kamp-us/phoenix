# Changelog

## [0.3.0](https://github.com/kamp-us/phoenix/compare/pipeline-cli-v0.2.1...pipeline-cli-v0.3.0) (2026-08-16)


### Features

* **pipeline:** a held child is born assigned, and the plan gate verifies the barrier it cannot flip away ([#4693](https://github.com/kamp-us/phoenix/issues/4693)) ([#4991](https://github.com/kamp-us/phoenix/issues/4991)) ([4f49c62](https://github.com/kamp-us/phoenix/commit/4f49c6287034715b048d2d94d30dfb9ad2461c2f))
* **publish:** resolve the release tag to a published package ([#4801](https://github.com/kamp-us/phoenix/issues/4801)) ([#4817](https://github.com/kamp-us/phoenix/issues/4817)) ([ec8a00a](https://github.com/kamp-us/phoenix/commit/ec8a00af6dd4eb1bfa600d6478fa565efa2c5a18))
* **roadmap:** declare the campaign in exclusive focus as a guarded ## Focus section ([#5012](https://github.com/kamp-us/phoenix/issues/5012)) ([#5084](https://github.com/kamp-us/phoenix/issues/5084)) ([e2f877d](https://github.com/kamp-us/phoenix/commit/e2f877d27dd6aa7d6961df466dfad3ab3a5cac92))


### Bug Fixes

* **ci:** skill-gh-lint walks every plugin dir, and reds when it does not ([#5004](https://github.com/kamp-us/phoenix/issues/5004)) ([#5037](https://github.com/kamp-us/phoenix/issues/5037)) ([240d10f](https://github.com/kamp-us/phoenix/commit/240d10f897d41071f98e087b74ccb69a2d557e02))
* **hooks:** dispatch the worktree sweep instead of running it on SessionStart ([#4998](https://github.com/kamp-us/phoenix/issues/4998)) ([#5065](https://github.com/kamp-us/phoenix/issues/5065)) ([e7474ab](https://github.com/kamp-us/phoenix/commit/e7474ab0f4a92ec191118626b224390b8788a8b5))
* **pipeline-cli:** a refused invocation is not a verdict — bad flags exit 4, not `stop` ([#5072](https://github.com/kamp-us/phoenix/issues/5072)) ([#5091](https://github.com/kamp-us/phoenix/issues/5091)) ([b757a65](https://github.com/kamp-us/phoenix/commit/b757a65038631de7b34d9335ec423b2795e222d0))
* **pipeline-cli:** the subprocess-budget guard scans every workspace member, not just its own package ([#4858](https://github.com/kamp-us/phoenix/issues/4858)) ([#5014](https://github.com/kamp-us/phoenix/issues/5014)) ([5e1259d](https://github.com/kamp-us/phoenix/commit/5e1259dbbd5cbb6b395d67284930d61523792726))
* **pipeline:** a banked §CP PR with no ticking approval-watcher now reds ([#4754](https://github.com/kamp-us/phoenix/issues/4754)) ([#4983](https://github.com/kamp-us/phoenix/issues/4983)) ([724eea7](https://github.com/kamp-us/phoenix/commit/724eea7cf51c9a42fb212db45b0bd430220f4567))
* **scratchpad:** publish the owner stamp atomically so a lost race is exit 4, not exit 6 ([#4864](https://github.com/kamp-us/phoenix/issues/4864)) ([#4877](https://github.com/kamp-us/phoenix/issues/4877)) ([7d58890](https://github.com/kamp-us/phoenix/commit/7d588903e40232999b64bb2dd56707e2f1d46eed))
