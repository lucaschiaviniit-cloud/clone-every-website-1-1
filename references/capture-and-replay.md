# Phase A: capture and local replay

Read only while acquiring/reproducing the current target. All evidence must come from that target and this run. The first deliverable is a working local execution of the deployed frontend, not an independently authored replacement.

## Discover the mechanisms before configuring scenarios

Inspect the page at desktop 1440×900, tablet 768×1024 and mobile 390×844, DPR1 by default. Preserve locale, timezone, color scheme and reduced-motion setting in the run config. Discover each major section, menus, significant hover/focus states, sticky regions, scroll-linked sequences, sliders, overlays, video and canvas. Record the selectors and before/after expectations actually observed; do not copy selectors from an example. Add at least the target's significant interactions to the load/scroll defaults. If an interaction cannot be safely exercised, report it as untested.

Observe any redirect to the actual final page during preflight. The engine confines navigation to the selected page; capture the final URL and record the submitted URL plus redirect observation instead of treating a canonical or language redirect as a missing asset. Do not turn this into a crawl of additional routes.

Read `tools/lab/configs/capture.json` for the schema, not as a complete interaction test. A generic config covers sampling and scrolling, not all page behavior. The engine supports time, click, hover, focus, key and scroll scenarios, optional preconditions and expectations. When the target requires a new action, implement and verify it in an isolated extension; do not report a skipped action as passed. User-specified viewport/route scope takes precedence over defaults.

Capture public read-only resources required by the requested page. Record target/asset hosts and the factual user request. Cross-origin script/CSS/image/font/media/worker assets can be discovered under the engine's resource policy; fetch/XHR to unrelated hosts needs explicit configuration and an explanation of its necessity. Block unrelated tracking, writes/form submission, WebSockets and service workers. A tracker failure intentionally caused by this policy must be labeled separately from a missing required asset. Do not navigate extra pages merely because their chunks are prefetched.

## Preserve browser evidence

Keep the initial HTML distinct from mutated runtime DOM. Capture open shadow DOM and accessible frames with boundary notes; closed or inaccessible contents remain unknown. Preserve CSS stylesheets, inline CSS, accessible CSSOM, computed styles, custom properties, media queries, scoped attributes, font faces, inline SVG and pseudo-element observations. Record geometry and viewport state.

Store observed resource URL/method/status/headers/MIME, response bodies deduplicated by SHA256, body limits and failures. Intercept and consume response bodies before the browser closes streams, including worker/image-sequence traffic. Keep image frames indexed by their actual URL/index, not completion order. Preserve complete videos and local byte-range support where possible. A canvas screenshot does not recover its scene graph, shader or underlying geometry.

Retain source-map URLs/headers when observed; inspect maps if available. Do not conclude that original development source was recovered merely from bundle names or scoped CSS. No observed map is not proof that no map exists elsewhere.

## Local execution and comparison

Use the captured V2 replay as the default functional baseline. V0 is a static comparison; additional catalog variants are not automatically different frontends. Preserve corpus and software identities so results remain attributable.

The local preview must work without the original remote site: replay observed resources locally, include all requested viewport assets for interactive resize, support GET/video range semantics and log blocked/unavailable requests. Match the requested pathname, not only `/`. Serve over loopback HTTP. Check the actual page visually and with its scenarios. A generic proxy fallback or a page that silently calls the original server does not satisfy local independence.

Repair acquisition or replay omissions before presenting the baseline. New captures go to new run/corpus directories. If deliberately modifying a replay, keep the original corpus intact, identify the new baseline directory in run state and recompute its inventory; never rewrite reference evidence to hide a mismatch.

For replay evaluation/benchmarking use the engine's offline commands. Keep assertion failures, unavailable resources, timeouts and excluded overload runs visible. Use repeated runs when the claim needs repeatability. Do not silently replace failed runs or combine unrelated capture identities.

## Motion and review

Distinguish CSS/WAAPI animations, GSAP/JS timelines, video playback, scroll-linked frame sequences and procedural GPU rendering. Fixed WAAPI time does not freeze JS, GSAP, video or WebGL. Keep natural-clock timestamps and observed variability. If synchronizing video frames for a supplemental visual comparison, label it as a separate protocol and retain the natural-clock results. Record all masks/thresholds and their reasons.

Present the baseline URL and what was checked. Say plainly that this is the deployed frontend running locally and that editable component source is the next phase. Ask for the user's accuracy decision and stop; do not begin source components while waiting. Persist `awaiting_user_review` and the next action so a different agent can resume without the original chat.
