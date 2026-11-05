# Palette Library Implementation Plan

> **For agentic workers:** Execute tasks in order with focused red-green tests and validation at each boundary.

**Goal:** Deliver offline palette management, image sampling, gradient creation, and durable palette application to Tavotto figures.

**Architecture:** Store user palettes under the selected Workbench library root behind authenticated APIs and atomic writes. Provide a React palette library/editor and supply saved palettes to existing inspector controls. Store custom colormap colors in self-contained figure override values and replay them through the existing worker and transactional writeback pipeline.

**Tech Stack:** React 19, TypeScript, Flask, Matplotlib, Python, Rust workerd, Vitest, pytest and Playwright.

---

### Task 1: Palette persistence and endpoints

**Files:** `src/tavotto/workbench/palettes.py`, `src/tavotto/workbench/api.py`, `tests/test_workbench_palettes.py`.

- [ ] Write behavioral tests for seeded library, CRUD, save-as, validation, root isolation and atomic write failures.
- [ ] Run `.venv/Scripts/python.exe -m pytest tests/test_workbench_palettes.py -q` and observe missing-feature failures.
- [ ] Implement validated versioned palette records under the selected root, safe IDs, atomic commits, and authenticated routes. Preserve existing data on errors and do not reseed deleted palettes.
- [ ] Re-run targeted tests and backend lint.

### Task 2: Color operations and editor

**Files:** `web/src/workbench/paletteModel.ts`, `web/src/workbench/PaletteLibrary.tsx`, `web/src/workbench/PaletteEditor.tsx`, `web/src/workbench/WorkbenchApp.tsx`, `web/src/workbench/workbench.css`, corresponding Vitest suites.

- [ ] Write failing tests for normalization, adjacent interpolation with preserved endpoints, ordering, save-as and selection.
- [ ] Implement the pure color operations, then palette cards, editor, color selector and draft guards; run targeted Vitest tests.
- [ ] Write image sampling tests for coordinate mapping, zoom and alpha composition; implement local-only image canvas and magnifier, then re-run tests.

### Task 3: Apply colors to figure properties

**Files:** `web/src/components/ui/Input.tsx`, `web/src/components/inspector/ElementInspector.tsx`, `web/src/workbench/TavottoEditor.tsx`, relevant inspector tests.

- [ ] Add a failing test selecting a saved swatch for an editable line color while preserving the existing undo path.
- [ ] Supply palettes to the embedded Workbench editor and integrate a palette picker with existing color controls. Test figure edits, undo and saved palette changes.

### Task 4: Durable custom colormaps

**Files:** `src/tavotto/engine/overrides.py`, related serialization/replay modules, `web/src/components/inspector/controls/ColormapPicker.tsx`, inspector and engine tests, any required protocol parity files.

- [ ] Add failing real Matplotlib tests for image/colorbar, continuous and stepped custom maps, hot state versus cold replay, original restore and invalid input.
- [ ] Define a bounded, versioned self-contained colors representation, support it in the existing override chain and export/writeback without relying on mutable palette IDs.
- [ ] Integrate the selector, run Python/Rust protocol tests and end-to-end save, reopen and export verification, including sibling colorbars.

### Task 5: Final verification

**Files:** `web/e2e/workbench-palette.spec.ts`, `docs/workbench/usage.md`.

- [ ] Test create, edit, gradient, image sampling and apply flow in a real browser; verify small windows and no uploads.
- [ ] Run targeted pytest and Vitest, Ruff, frontend build, playground / MCP rebuild and applicable supervisor parity tests. Inspect actual UI screenshots.
- [ ] Review full diff and report any unsupported paths or verification limits. Do not change version, create tags, publish or install.
