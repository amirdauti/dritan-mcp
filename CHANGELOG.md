## [0.3.0](https://github.com/amirdauti/dritan-mcp/compare/v0.2.7...v0.3.0) (2026-02-13)

### Features

* expand MCP tools with token search and chart flow ([2ab1ccd](https://github.com/amirdauti/dritan-mcp/commit/2ab1ccda385c6726a7bfd4df4360afa2d58fd83e))

## [0.2.7](https://github.com/amirdauti/dritan-mcp/compare/v0.2.6...v0.2.7) (2026-02-07)

### Bug Fixes

* **ci:** trigger release ([a4ac0b4](https://github.com/amirdauti/dritan-mcp/commit/a4ac0b4506a11439aa4fdd7e669889f87be13481))

## [0.2.6](https://github.com/amirdauti/dritan-mcp/compare/v0.2.5...v0.2.6) (2026-02-07)

### Bug Fixes

* **ci:** force OIDC by clearing npm auth config ([4a9b407](https://github.com/amirdauti/dritan-mcp/commit/4a9b407ffc985478730d932a5261840290617332))

## [0.2.5](https://github.com/amirdauti/dritan-mcp/compare/v0.2.4...v0.2.5) (2026-02-07)

### Bug Fixes

* **ci:** publish to npm via OIDC in release workflow ([9d20ed3](https://github.com/amirdauti/dritan-mcp/commit/9d20ed32a781beea6a4b3e5d581224cefc1b65a0))

## [0.2.4](https://github.com/amirdauti/dritan-mcp/compare/v0.2.3...v0.2.4) (2026-02-07)

### Bug Fixes

* **ci:** publish from tags via npm trusted publishing ([729332c](https://github.com/amirdauti/dritan-mcp/commit/729332c558a49a2c25f08b2dfae719f0318b1d7a))

## [0.2.3](https://github.com/amirdauti/dritan-mcp/compare/v0.2.2...v0.2.3) (2026-02-07)

### Bug Fixes

* **ci:** use npm trusted publishing OIDC (no token) ([9bd7dad](https://github.com/amirdauti/dritan-mcp/commit/9bd7dad91ba7b1c0af74235ee9758fd19b79adc9))

## [0.2.2](https://github.com/amirdauti/dritan-mcp/compare/v0.2.1...v0.2.2) (2026-02-07)

### Bug Fixes

* **ci:** publish to npm using NPM_TOKEN ([3520251](https://github.com/amirdauti/dritan-mcp/commit/35202512bf14e4d94c5bfe788e0f2744b9716e23))

## [0.2.1](https://github.com/amirdauti/dritan-mcp/compare/v0.2.0...v0.2.1) (2026-02-07)

### Bug Fixes

* **ci:** avoid npm auth config for OIDC publish ([8477e8f](https://github.com/amirdauti/dritan-mcp/commit/8477e8f271830f396a4a949415c1d4d9be269b63))

## [0.2.0](https://github.com/amirdauti/dritan-mcp/compare/v0.1.2...v0.2.0) (2026-02-06)

### Features

* improve api key UX ([08a1ddb](https://github.com/amirdauti/dritan-mcp/commit/08a1ddbe40decbd445fb86483cf93005c24feae4))
* publish as @dritan/mcp ([33551d9](https://github.com/amirdauti/dritan-mcp/commit/33551d9b494a83945143d43c7fddf92cdb8882d0))

### Bug Fixes

* **ci:** add OIDC debug + restore setup-node config ([0f54e2b](https://github.com/amirdauti/dritan-mcp/commit/0f54e2bd5aa1fd076ef921889747900b5e9669ac))
* **ci:** align trusted publisher workflow ([c642324](https://github.com/amirdauti/dritan-mcp/commit/c642324fd1906d274c1f2038fce7e09da75ac9ac))
* **ci:** force OIDC by unsetting npm token env ([36bd456](https://github.com/amirdauti/dritan-mcp/commit/36bd4564bf38139f93d95645b8c10bf66d33404e))
* **ci:** pin npm for releases ([5c11f06](https://github.com/amirdauti/dritan-mcp/commit/5c11f0679cc3f5d616ac6a1da79c74532f9e3971))
* **ci:** publish via OIDC ([c6de56c](https://github.com/amirdauti/dritan-mcp/commit/c6de56cb57e651c0b59ece26741b2c62fd20c447))
* **ci:** publish via OIDC without npmrc token ([7de9e7f](https://github.com/amirdauti/dritan-mcp/commit/7de9e7f5354488b178ecd601dafd0c1df09ac328))
* **ci:** publish with trusted publishing OIDC ([62e4713](https://github.com/amirdauti/dritan-mcp/commit/62e4713b524d615c26592a299c59402f2f060b41))
* **ci:** sanitize npm auth env ([5b6b3ba](https://github.com/amirdauti/dritan-mcp/commit/5b6b3ba44203752bd21dc45c4e03aff040d8d353))
* **ci:** set trusted publisher environment ([ad277b2](https://github.com/amirdauti/dritan-mcp/commit/ad277b2915cc2f337dd96a366519b3022e67dacc))
* **ci:** unset npm token env at publish time ([368dd87](https://github.com/amirdauti/dritan-mcp/commit/368dd876e642d3135b01514e0b3abf22be04774e))
* **ci:** unset npm userconfig env vars ([0b089bf](https://github.com/amirdauti/dritan-mcp/commit/0b089bf8ce95e5a27e0e10efdf5619368de40ee3))
* **ci:** unset token auth at job level ([2a78e7d](https://github.com/amirdauti/dritan-mcp/commit/2a78e7d478bec429d653bb6cd032d0e6e00a43f0))
* **ci:** use npm install in gha ([f82964e](https://github.com/amirdauti/dritan-mcp/commit/f82964ed4b8429f85f1f889c6cadcf969da81716))
* **ci:** use OIDC trusted publishing ([070f089](https://github.com/amirdauti/dritan-mcp/commit/070f089d73fe8fc7df47ff6cf175934581ce91a3))
* **ci:** use setup-node v4 for npm trusted publishing ([e49fad8](https://github.com/amirdauti/dritan-mcp/commit/e49fad88d1cb3cfb64488ea5f4a2bcb2f3402ded))
