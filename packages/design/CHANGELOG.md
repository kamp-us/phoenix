# Changelog

## 0.1.0 (2026-10-04)


### Features

* compound parts: PrimaryActions and the Overflow disclosure ([#8677](https://github.com/kamp-us/phoenix/issues/8677)) ([#8704](https://github.com/kamp-us/phoenix/issues/8704)) ([728ff1e](https://github.com/kamp-us/phoenix/commit/728ff1efcdb313694cf3663d0e3ad4b8afe8cb63))
* compound parts: Surface, Field, Toolbar, Settings, Hint and the Control primitive ([#8692](https://github.com/kamp-us/phoenix/issues/8692)) ([58fc462](https://github.com/kamp-us/phoenix/commit/58fc46236d88dce0c25352748ccc19ae39201ffc))
* **design:** remove the composer hint line entirely ([#8745](https://github.com/kamp-us/phoenix/issues/8745)) ([87bc6b5](https://github.com/kamp-us/phoenix/commit/87bc6b52b799f28d3ae5627de3e46ba6c55a3c15)), closes [#8736](https://github.com/kamp-us/phoenix/issues/8736)
* **design:** the send-delivery rule moves off variant onto its own prop ([#8675](https://github.com/kamp-us/phoenix/issues/8675)) ([#8690](https://github.com/kamp-us/phoenix/issues/8690)) ([46e0516](https://github.com/kamp-us/phoenix/commit/46e051679b15a16b60770e22d76a9591bbd27d66))
* **epic:** Run a test-audit subsystem sweep over every test surface in the repo ([#10122](https://github.com/kamp-us/phoenix/issues/10122)) ([e9210e4](https://github.com/kamp-us/phoenix/commit/e9210e418cf0913607579d1cc8420ac7a9a6ff32))
* **epic:** Six packages import Tuval's runtime from apps/tuval, which is an app ([#9676](https://github.com/kamp-us/phoenix/issues/9676)) ([90dffca](https://github.com/kamp-us/phoenix/commit/90dffcaa8fb0cab7fdb65c799b27ae9447e9f6cb))
* Markdown task items still print the literal [x] marker the [#8023](https://github.com/kamp-us/phoenix/issues/8023) ruling replaced ([#10286](https://github.com/kamp-us/phoenix/issues/10286)) ([049fac7](https://github.com/kamp-us/phoenix/commit/049fac7f4b6f3088d40de9a7b659e22c7ddd4259))
* packages unit tests job runs every package's suite whatever the diff touched ([#10070](https://github.com/kamp-us/phoenix/issues/10070)) ([b94f01b](https://github.com/kamp-us/phoenix/commit/b94f01b451eebb2b12778551b9a5f74647ba7c59))
* The agent composer takes twice the height it needs; compact is its one shape ([#8713](https://github.com/kamp-us/phoenix/issues/8713)) ([eb756c6](https://github.com/kamp-us/phoenix/commit/eb756c69863044f07cbc6a62145d0258cec96469))
* Tuval's chat window and the atölye exhibit assemble the composer from its parts ([#8678](https://github.com/kamp-us/phoenix/issues/8678)) ([#8710](https://github.com/kamp-us/phoenix/issues/8710)) ([a39812f](https://github.com/kamp-us/phoenix/commit/a39812fe38ce1bfbc9ee4a2edef4a53a56ecbba4))


### Bug Fixes

* **design:** give --danger, --success and --warning a light-scheme value that clears 4.5:1 ([#8337](https://github.com/kamp-us/phoenix/issues/8337)) ([#9994](https://github.com/kamp-us/phoenix/issues/9994)) ([4680f61](https://github.com/kamp-us/phoenix/commit/4680f61703580df05f4f21b379ed0ada4cdadb04))
* **design:** grow the toast close button's hit area to the 36px floor ([#9634](https://github.com/kamp-us/phoenix/issues/9634)) ([#9700](https://github.com/kamp-us/phoenix/issues/9700)) ([a46323f](https://github.com/kamp-us/phoenix/commit/a46323f747b37877e6e916d996e6d93444221ec0))
* **design:** name the dialog close button ([#6776](https://github.com/kamp-us/phoenix/issues/6776)) ([#9617](https://github.com/kamp-us/phoenix/issues/9617)) ([16f4c42](https://github.com/kamp-us/phoenix/commit/16f4c42e169e820ddbb6068eb898675dd5ffb897))
* **design:** name the toast close button in the reader's language ([#6777](https://github.com/kamp-us/phoenix/issues/6777)) ([#9633](https://github.com/kamp-us/phoenix/issues/9633)) ([83f3894](https://github.com/kamp-us/phoenix/commit/83f3894e101e653080b9beb1e9937190eabeecec))
* **design:** pair the solid danger fills with --danger-fg, not the accent's foreground ([#9992](https://github.com/kamp-us/phoenix/issues/9992)) ([#10004](https://github.com/kamp-us/phoenix/issues/10004)) ([3a63869](https://github.com/kamp-us/phoenix/commit/3a63869602646f0a8ef2307a23aa5706070fc076))
* **design:** re-point the undeclared --t-heading-sm at --t-h-feed ([#8760](https://github.com/kamp-us/phoenix/issues/8760)) ([#8774](https://github.com/kamp-us/phoenix/issues/8774)) ([dcb645e](https://github.com/kamp-us/phoenix/commit/dcb645e4bb086f8ed8b804f5402361907e588cb5))
* **design:** the composer parity test drives and reads AgentChatInput.Error ([#8773](https://github.com/kamp-us/phoenix/issues/8773)) ([#9429](https://github.com/kamp-us/phoenix/issues/9429)) ([1745c62](https://github.com/kamp-us/phoenix/commit/1745c621dc32752688631c820b41394b294753b3))
* **design:** the composer parity test stops pinning Manti's late layer bookkeeping ([#8899](https://github.com/kamp-us/phoenix/issues/8899)) ([#9087](https://github.com/kamp-us/phoenix/issues/9087)) ([83ddf4b](https://github.com/kamp-us/phoenix/commit/83ddf4be94b30c7e40b7bcc6cba2be12524703ff))
* Restored Agy session times out and leaves its child running ([#9520](https://github.com/kamp-us/phoenix/issues/9520)) ([1751c9a](https://github.com/kamp-us/phoenix/commit/1751c9ac111d46b0180d4a60506f5fb001dbd42d))
