# Phase B: reconstruct source from the approved build

Read only after the user has approved Phase A and the recorded approval still matches the corpus and baseline inventory. Use a fresh source workspace. The replay remains the reference, not the product source.

## Recover evidence, preserve provenance

Inventory the initial HTML, runtime states, stylesheet cascade, resource manifest, payloads, workers and bundle import graph. Inspect available source maps first. Otherwise format/parse relevant JavaScript chunks with AST tools; trace components through names, scope attributes, classes, render functions, event handlers and lifecycle hooks. Do not dump huge vendor bundles or inline SVGs into agent context: extract the relevant symbols/literals and record their source hashes.

Classify files and mechanisms as recovered, adapted, rewritten or unknown. Asset files and shader literals can be recovered exactly; a reconstructed component architecture or CMS schema is an inference unless corroborated. Preserve metadata linking original URL/body hash to local file. Do not imply the original repository, comments, types, tests, private backend or editor history were recovered.

## Source structure and styling

Choose the source stack from the observed page and user constraints. Framework evidence can include runtime payloads, render code and module names. Prefer matching the original mechanisms where that improves fidelity; do not automatically translate every target into one framework or impose a new design system.

Split the initial markup into editable semantic components, then replace meaningful repetition with shared components/props/data. Preserve original fonts, image rendition/crop, CSS ordering, specificity, scoped selector attributes, pseudo-elements and breakpoints. Rewrite resource URLs to local files. Do not inject the whole captured page as an HTML string and call it component reconstruction.

Keep the original distributed CSS when usable, formatting and documenting changes. Missing fonts/image variants must be reported; substitutions can change geometry and cross-browser behavior. Give assets stable indexed names or hash-based names with provenance, and include them in the deliverable rather than relying on the corpus path.

## Recover actual motion, not only appearance

Trace the original animation mechanism and parameters: durations, easing, delay, stagger, transform origins, clipping, blur, thresholds, scroll mapping, pinning/sticky geometry and hover/focus/leave/reset events. Use original CSS transitions/keyframes when recovered. Rebuild event wiring, mounting, resize and cleanup in readable source. Explicit standard dependencies are acceptable; executing an opaque captured application bundle is not a replacement for the new source implementation.

Use a coordinated requestAnimationFrame loop for scroll/motion and recovered smooth-scroll behavior if present. Wait for fonts before text splitting, preserve line wrapping and synchronize related effects. Inspect forward/reverse scroll, pointer leave, repeated entry, resize and mobile variants; one screenshot does not establish correct lifecycle.

For an image sequence, copy the real frames, preserve frame indices, map scroll progress to the observed index/thresholds, implement responsive cover rendering and bounded preload. Do not claim a newly reconstructed 3D scene when replaying prerendered frames.

For video, reuse the acquired media and observed playback behavior. For GPU effects, recover shader source/geometry/textures when available; implement the actual WebGL/WebGPU lifecycle and uniforms. A recovered video plus pointer-driven shader is different from a fully procedural 3D scene. If scene data, simulation state or server-supplied geometry is unavailable, document the gap instead of silently replacing it with a flat screenshot.

For menus, sliders, tabs, dialogs and forms, reconstruct state transitions, keyboard/focus behavior and responsive layout from current-run evidence. Backend/form writes remain outside the default scope; local interactions must not transmit submissions. Reusing a generic component pattern is acceptable only when it matches the observed behavior; a template is not evidence of equivalence.

## Agent handoff

Use the run's `analysis/reconstruction-index.json` and request section dossiers with the lab `dossier` command. Before implementing a component, record in its run-local handoff the exact asset URL/query/hash and viewport rendition, distributed CSS/cascade dependencies, observed state transitions and motion parameters with evidence paths, and the checks that will verify them. Treat unknowns explicitly; do not freeze live clocks or replace a mechanism with its initial snapshot. For animated text verify rich markup, explicit line breaks and measurements of current mounted nodes after mutations/resize. Reuse the existing dossier and asset map rather than writing target-specific extraction/preview tooling when the bundled helpers suffice. Record reviewed component-to-scenario mappings in the inventory `impacts` so local corrections can select existing checks safely. Read only relevant fragments; limits and candidate CSS/JS links are not recovered architecture. Review shared fonts/cascade/runtime contracts before distributing components. Use the source comparison wrapper described in [v1-workflow.md](v1-workflow.md) for selected checks, then full final comparison. During normal correction work, optional task/problem annotations described in [measurement.md](measurement.md) record repeated attempts without adding a separate model turn.

Each builder receives its file ownership, relevant approved baseline/corpus paths, component evidence, asset map and interaction expectations. Include shared cascade/runtime contracts, not the whole site or past examples. Builders report written files, evidence used, unknowns and checks actually run. The coordinator integrates shared changes and the independent verifier reports defects from measured behavior. Preserve unresolved defects in a run-local handoff rather than accumulating unverified success claims.
