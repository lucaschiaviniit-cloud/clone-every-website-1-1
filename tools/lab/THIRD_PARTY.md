# Incorporated third-party code

The toolkit retains narrowly selected utilities from earlier inspected repositories. These are local utility excerpts, not external cloning applications or agents. No competing application is installed or executed.

| Local module | Origin and pinned commit | Use and license |
|---|---|---|
| `src/third-party/ai-site-collectors.mjs` | Mahanaicoach/ai-site-cloner, `ad6189bf33945a4431491827c4fde4382f0b4407` | `collectTokens` and `splitRules`, MIT; original header retained; `licenses/ai-site-cloner-LICENSE`. |
| `src/adapters/webembedding.ts` | jongko54/webEmbedding, `fa1034a0b01437fdd920bec4b8d3bc9e9e45afe0` | Ported header sanitization policy, MIT; `licenses/webEmbedding-LICENSE`. |
| `src/third-party/rever-helpers.ts` | greekr4/rever-browser, `770eb95c3bc0eb47410626980fc4ba26e0b135c2` | HAR header conversion and bundler recognition, Apache-2.0 plus NOTICE; corresponding files under `licenses/`. |
| `fixtures/lab-font.woff2` | Inter font, synthetic technical fixture | SIL Open Font License, `licenses/inter-OFL.txt`. |

`docs/reuse-lock.json` records pinned upstream source identifiers. Application frameworks and AI SDKs from those repositories are not included. Adapter and synthetic browser tests verify the selected utility behavior; no upstream application's tests are claimed to have passed.

The npm dependency inventory is [docs/dependencies.json](../../docs/dependencies.json); npm packages and Chromium are installed separately, not vendored in this repository. The release placeholder video is a procedural project asset under Apache-2.0; see [its provenance](assets/media/provenance.json) and [the generator](../../scripts/generate-placeholder-video.mjs).

Release packaging trims trailing blank lines in the selected utility files and one MIT license file; utility logic and attribution are unchanged.
