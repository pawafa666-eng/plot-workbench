# Codex assistance and deliberate releases

The user requested removal of the online template entry, deliberate releases only after changes are complete and explicitly approved, and local Codex assistance in template creation and embedded Tavotto editing.

## Boundaries

- Work directly on `workbench/v1`. The initial change was to remain unpublished. The user's subsequent instruction, "继续，一切无误后发布最终版", authorizes one final release after verification; prepare `v1.2.0` for the new Codex feature. Remote repository archival remains outside this task.
- Remove the online template link and its unused branding/style constants. Keep local template import, creation, validation, categories and favorites.
- A tag build may prepare and validate a draft. Publishing that draft requires the user's separate release decision. Record this requirement in the repository instructions and release documentation.
- Reuse Tavotto's `ai_bridge` and agent registry for CLI discovery, login readiness, configured model/effort, provider injection, cancellation and process isolation. No new account setup, API keys, hardcoded model IDs, or changes to the user's Codex configuration.

## Code assistance

Both entry points show a Codex dialog with a prompt, dynamic CLI model/effort, progress, code diff and an explicit apply action. Only code and data structure are supplied as context; no table values are automatically sent. Codex edits a copy under `config.data_dir()`, never a source/template file directly. Closing the dialog cancels its task and prevents late responses from applying to another editor.

For templates, apply replaces only the unsaved editor code and invalidates its previous validation. Run and validate remains mandatory before save.

For Tavotto, generation captures the current base code, overrides and session generation. Apply rejects stale results and builds a fresh candidate worker, preserving all existing override histories. Invalid code, missing outputs or override warnings leave the original session unchanged. Successful apply replaces the in-memory session, not its saved plot. Finish still compares hot and cold geometry and pixels before committing. If base code changes, verification and export cover every existing output, and the new base is persisted for reopening. Cancel leaves the saved plot untouched.

## Validation

Test staged-only assistant edits, failed/cancelled/invalid/stale candidates, session ownership, multiple output replay and restart, retained overrides and original files, frontend confirmation and cleanup, and draft-only release behavior. Use mocked CLI jobs for deterministic coverage; do not make paid model requests during tests. Run Ruff, targeted backend/frontend tests, frontend type/build and browser smoke. Actual Codex account execution is reported separately from mocked coverage.
