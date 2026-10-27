# Workbench Codex and Release Implementation Plan

> Execute the user-authorized scope in this checkout. Independent frontend and release tasks are delegated according to the dispatching-parallel-agents skill; backend integration and final verification remain with the parent.

**Goal:** Retire the online template entry, make releases deliberate, and support confirmed Codex code edits in both template and Tavotto editors.

**Architecture:** Shared staged assistant service delegates CLI lifecycle to `engine.ai_bridge`. Template apply remains in the frontend draft; Tavotto apply replaces a candidate session only, and finish verifies every changed output before saving.

**Tech Stack:** Flask, Python standard library, existing worker/PDF contracts, React/TypeScript, Vitest, pytest.

- [x] Remove the online template entry/constants/styles, retaining local tools; update existing UI test.
- [x] Replace automatic public release promotion with verified draft preparation; document explicit human release decision in repository rules and release guide; verify old auto-publication fails the contract.
- [x] Add `workbench/assistant.py` and authenticated assistant start/poll/cancel/apply routes. Test with fake CLI jobs before implementation.
- [x] Stage generated code in a new Tavotto worker, reject stale or invalid candidates, retain overrides, and persist a changed base only after the existing hot/cold geometry and pixel verification. Verify all outputs when base changes.
- [x] Add a reusable Codex dialog with backend-reported capabilities, prompt/progress/diff, cancellation and explicit apply. Connect it to template and Tavotto editors with lifecycle tests.
- [x] Update usage documentation for Codex entry points, data sent, cancellation and validation boundaries.
- [x] Run Ruff before backend tests, targeted frontend tests, full frontend build and translation checks, playground build and both browser workflows. Verify mutation checks and resolve the reviewed cancellation race.
- [x] Perform one live Codex request on synthetic code and render the generated result. Preserve user configuration; extend local model choices and explain model/CLI mismatch after detecting an older CLI.
- [ ] Following the user's explicit final-release instruction, commit the four synchronized `1.2.0` versions and release notes, build/verify the signed Windows candidate, inspect actual release assets, and only then publish the single final Release.
