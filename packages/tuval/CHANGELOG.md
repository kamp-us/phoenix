# Changelog

## 0.1.0 (2026-10-04)


### Features

* A running Tuval process keeps its old code after a hot reload ([#9824](https://github.com/kamp-us/phoenix/issues/9824)) ([da2bfab](https://github.com/kamp-us/phoenix/commit/da2bfaba650c3780a8f2f824eba54701f6532be3))
* **epic:** One Tuval desk runs many projects, with a tuval command on npm ([#9842](https://github.com/kamp-us/phoenix/issues/9842)) ([2714e82](https://github.com/kamp-us/phoenix/commit/2714e822f5c84cb16d2dcd88bddc216813acbdb4))
* **epic:** Run a test-audit subsystem sweep over every test surface in the repo ([#10122](https://github.com/kamp-us/phoenix/issues/10122)) ([e9210e4](https://github.com/kamp-us/phoenix/commit/e9210e418cf0913607579d1cc8420ac7a9a6ff32))
* **epic:** Six packages import Tuval's runtime from apps/tuval, which is an app ([#9676](https://github.com/kamp-us/phoenix/issues/9676)) ([90dffca](https://github.com/kamp-us/phoenix/commit/90dffcaa8fb0cab7fdb65c799b27ae9447e9f6cb))
* **epic:** Tuval still runs its own Effect host on tea 0.12.0 while tea 0.18.0 ships the engine it needs ([#9798](https://github.com/kamp-us/phoenix/issues/9798)) ([7194b7d](https://github.com/kamp-us/phoenix/commit/7194b7dca048216d31d835999a2cb9809a421d3a))
* packages unit tests job runs every package's suite whatever the diff touched ([#10070](https://github.com/kamp-us/phoenix/issues/10070)) ([b94f01b](https://github.com/kamp-us/phoenix/commit/b94f01b451eebb2b12778551b9a5f74647ba7c59))


### Bug Fixes

* A prompt sent right after a kernel spawn of an ai-agent child is refused ([#9970](https://github.com/kamp-us/phoenix/issues/9970)) ([fa4fd2c](https://github.com/kamp-us/phoenix/commit/fa4fd2c220a61d2f7034d05f294751ca6b41a4bd))
* **tuval:** a swapped process's in-ports translate through the reloaded row's receivers ([#9823](https://github.com/kamp-us/phoenix/issues/9823)) ([#9845](https://github.com/kamp-us/phoenix/issues/9845)) ([2cd28b3](https://github.com/kamp-us/phoenix/commit/2cd28b372251e6cd1409a7e9189408dd497f1740))
* **tuval:** keep a spawner's layer memo map out of its children's handlers ([#10025](https://github.com/kamp-us/phoenix/issues/10025)) ([#10249](https://github.com/kamp-us/phoenix/issues/10249)) ([9b4dea2](https://github.com/kamp-us/phoenix/commit/9b4dea23275a9764c2dc94cc3466d758983dbce0))
