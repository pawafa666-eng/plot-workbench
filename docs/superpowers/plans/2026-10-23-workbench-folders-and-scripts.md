# Folder projects and ordinary scripts implementation plan

> **For agentic workers:** Use subagent-driven-development to implement the independent tasks below, then review requirements and correctness before release.

**Goal:** Support folder-based projects, ordinary multi-figure Matplotlib scripts, an online template gallery, concise controls, and a real Windows application icon.

**Architecture:** An explicitly chosen existing folder is the execution cwd. Its `.plot-workbench/` child owns manifests, snapshots and revisions; legacy project manifests remain readable. One plot owns an ordered `outputs` array with stable stems (`figure`, `figure_2`, …), with per-output Tavotto edits and a frozen common source. All figure capture runs in isolated Python children; Tavotto retains cold replay geometry and pixel verification before commit.

**Tech Stack:** React, Tauri, Flask, isolated Matplotlib/Pandas Python, GitHub Releases.

## Task 1: Folder storage

- [ ] Add folder-selection regression tests in `tests/test_workbench_store.py`: only `.plot-workbench` appears alongside existing user files; deleting and restoring never moves user files; moving the entire folder and reopening works; legacy projects still open.
- [ ] Extend `WorkbenchStore.create_project(name, path=None)` and folder discovery in `store.py`; expose a derived `working_directory` on project/plot records. Preserve legacy internal call compatibility, require the folder on the public create endpoint.
- [ ] Run targeted store and API tests, plus Ruff.

## Task 2: Script execution and output revisions

- [ ] Add failing tests for a normal script, guarded main, save-and-close, multiple figures, relative CSV reads, failed scripts, and data-aware legacy functions.
- [ ] Add a shared child-only execution helper that captures all distinct Figure objects without requiring a function, resets argv, uses the chosen cwd, redirects plotting exports into managed output directories, and preserves safe worker guards.
- [ ] Extend `runner.py`, `rendering.py`, `store.py`, and API artifact/export routes for `outputs: [{stem, title, preview_url}]`; first output remains `figure` for backwards compatibility. Save all artifacts atomically as one revision.
- [ ] Extend Tavotto open with optional `stem`; retain one frozen source and a map of complete overrides per output. Cold verification and unchanged output copying precede a single revision commit.
- [ ] Verify export code executes without nested wrappers and all outputs survive restart.

## Task 3: Functional UI

- [ ] Replace project name-only creation with folder selection and optional name; opening discovers the selected folder. Keep global templates in the configured app library.
- [ ] Add output selection to plot/template previews, selected-output export and Tavotto entry; save retains the whole output collection.
- [ ] Replace marketing prose and decorative English labels with short Chinese functional labels. Add online templates button using the central brand constant.
- [ ] Run Workbench frontend tests and production build.

## Task 4: Desktop and gallery

- [ ] Remove remote connection command, menu and frontend surface, keeping the main window ACL narrow. Update associated command/menu tests.
- [ ] Generate a plotting icon in all required Windows bundle sizes and verify PE/shortcut icon resources after installation.
- [ ] Create `pawafa666-eng/plot-workbench-templates` with synthetic self-contained Matplotlib examples, preview gallery, requirements, contribution instructions and license; verify every example in a clean child process before publishing.

## Task 5: Delivery

- [ ] Review spec compliance and code correctness, run appropriate Ruff, Python, frontend, packaging and isolated smoke checks.
- [ ] Bump the product version, push `workbench/v1`, run signed Windows packaging, install the release and test folder cleanliness, multi-figure rendering, legacy projects, Tavotto repeated edits and manual update checking.
- [ ] Deliver the repository and installer links with concise Chinese usage notes.
