# Changelog

## [0.1.11](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.10...argo-workflows-axi-v0.1.11) (2026-11-01)


### Bug Fixes

* **wf:** validate and patch resubmit priority ([#38](https://github.com/Dematom1/argo-workflows-axi/issues/38)) ([547a54c](https://github.com/Dematom1/argo-workflows-axi/commit/547a54cffa942e8abe060cb81dcf1a4fd8dadaa8))

## [0.1.10](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.9...argo-workflows-axi-v0.1.10) (2026-11-01)


### Bug Fixes

* **cli:** emit valid TOON for all help output ([#37](https://github.com/Dematom1/argo-workflows-axi/issues/37)) ([182420d](https://github.com/Dematom1/argo-workflows-axi/commit/182420d5e510a68a6f6d4ce1aec9e9af1a07649a))
* provide full-output guidance for truncated values ([#34](https://github.com/Dematom1/argo-workflows-axi/issues/34)) ([0184a3a](https://github.com/Dematom1/argo-workflows-axi/commit/0184a3ac2d61d11d0f6f6587eef6c491c9ebcea2))
* **setup:** make hook installation safer and idempotent ([#33](https://github.com/Dematom1/argo-workflows-axi/issues/33)) ([bac3311](https://github.com/Dematom1/argo-workflows-axi/commit/bac331191c480cd87a35a02939d041ab2c7adb11))

## [0.1.9](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.8...argo-workflows-axi-v0.1.9) (2026-11-01)


### Bug Fixes

* **cli:** make workflow resubmits idempotent ([#31](https://github.com/Dematom1/argo-workflows-axi/issues/31)) ([f29b4dd](https://github.com/Dematom1/argo-workflows-axi/commit/f29b4ddb66ee3b6811888876ad9b82f507f05e71))

## [0.1.8](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.7...argo-workflows-axi-v0.1.8) (2026-10-31)


### Features

* add session-end command memory ([#27](https://github.com/Dematom1/argo-workflows-axi/issues/27)) ([fdf0d87](https://github.com/Dematom1/argo-workflows-axi/commit/fdf0d8758d3dfcc5efff579a7541042a9b85e39c))


### Bug Fixes

* **commands:** quote target values in follow-up hints ([#26](https://github.com/Dematom1/argo-workflows-axi/issues/26)) ([e68ee08](https://github.com/Dematom1/argo-workflows-axi/commit/e68ee088181fa0dda6786f645eaa085806549541))
* **sessions:** prevent concurrent session record loss ([#29](https://github.com/Dematom1/argo-workflows-axi/issues/29)) ([900785e](https://github.com/Dematom1/argo-workflows-axi/commit/900785eeddfcf39d6282887f2e4c9f0d0ffce361))

## [0.1.7](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.6...argo-workflows-axi-v0.1.7) (2026-10-31)


### Bug Fixes

* **cli:** encode data-bearing string outputs as TOON ([#24](https://github.com/Dematom1/argo-workflows-axi/issues/24)) ([66a5ccd](https://github.com/Dematom1/argo-workflows-axi/commit/66a5ccda4e1b111e2224107788bfb508b29a265e))

## [0.1.6](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.5...argo-workflows-axi-v0.1.6) (2026-10-31)


### Bug Fixes

* **home:** clarify workflow list hints ([#22](https://github.com/Dematom1/argo-workflows-axi/issues/22)) ([3776a9f](https://github.com/Dematom1/argo-workflows-axi/commit/3776a9f850ea7938652fbfb2a62e63f87f2d0359))

## [0.1.5](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.4...argo-workflows-axi-v0.1.5) (2026-10-30)


### Bug Fixes

* keep workflow logs and tree messages in structured output ([#18](https://github.com/Dematom1/argo-workflows-axi/issues/18)) ([80ea8db](https://github.com/Dematom1/argo-workflows-axi/commit/80ea8dbda545fcf35349224b2ff9515898fa0373))
* **render:** keep help hints TOON-decodable ([#20](https://github.com/Dematom1/argo-workflows-axi/issues/20)) ([db57f92](https://github.com/Dematom1/argo-workflows-axi/commit/db57f9238e7b876e78bc7f1e62b53ee0c06d784b))
* **wf:** preserve filters and scope in expansion hints ([#19](https://github.com/Dematom1/argo-workflows-axi/issues/19)) ([8303ab2](https://github.com/Dematom1/argo-workflows-axi/commit/8303ab297f28ce8d693446aea1b253efcfb80a9b))

## [0.1.4](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.3...argo-workflows-axi-v0.1.4) (2026-10-30)


### Bug Fixes

* restore packed CLI executables ([#14](https://github.com/Dematom1/argo-workflows-axi/issues/14)) ([9f23113](https://github.com/Dematom1/argo-workflows-axi/commit/9f231134187b968ed6ec5723366ea81477bd9bf7))

## [0.1.3](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.2...argo-workflows-axi-v0.1.3) (2026-10-30)


### Bug Fixes

* reject malformed workflow list responses and inherited subcommands ([#11](https://github.com/Dematom1/argo-workflows-axi/issues/11)) ([1bdd745](https://github.com/Dematom1/argo-workflows-axi/commit/1bdd7455389ff88e7f47c383f9990d8952d27979))

## [0.1.2](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.1...argo-workflows-axi-v0.1.2) (2026-10-30)


### Bug Fixes

* **release:** stage npm publishes for approval ([#7](https://github.com/Dematom1/argo-workflows-axi/issues/7)) ([55859e7](https://github.com/Dematom1/argo-workflows-axi/commit/55859e76ffc08ecf552a9545e082676b6207aca4))

## [0.1.1](https://github.com/Dematom1/argo-workflows-axi/compare/argo-workflows-axi-v0.1.0...argo-workflows-axi-v0.1.1) (2026-10-29)


### Features

* add argo-workflows-axi v1, a read-first agent CLI for Argo Workflows ([#1](https://github.com/Dematom1/argo-workflows-axi/issues/1)) ([01bdea7](https://github.com/Dematom1/argo-workflows-axi/commit/01bdea76a67fad2b639e21fe9c495c70ab2e8d4f))
* automate release PRs and npm publishing ([#3](https://github.com/Dematom1/argo-workflows-axi/issues/3)) ([3adec35](https://github.com/Dematom1/argo-workflows-axi/commit/3adec35cb5214cbc86cccdf6ca78b0ff766b2ec8))


### Bug Fixes

* update vitest to patched version ([#4](https://github.com/Dematom1/argo-workflows-axi/issues/4)) ([523ceb0](https://github.com/Dematom1/argo-workflows-axi/commit/523ceb0cf1bbcbfa3007dc5310d5f221f4f82cd3))
