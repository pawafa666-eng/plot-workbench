# Plot Workbench Manual Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows x64 Plot Workbench updater that checks only after a user presses the Settings button and installs only a minisign-verified release from the Plot Workbench repository.

**Architecture:** Keep the UI behind the existing `desktop.ts` bridge and register Tauri's updater plugin with only the main-window capability. Ordinary branch builds remain unsigned installers; a stable `vX.Y.Z` build receives the public key as an Actions variable and the private key as an Actions secret, injects the Plot Workbench endpoint into the Tauri build, and publishes the signed archive and validated `latest.json` from a separate least-privilege job.

**Tech Stack:** React, Zustand, Vitest, Tauri 2 updater plugin, Rust, Python build/manifest scripts, GitHub Actions, GitHub CLI.

---

### Task 1: Make update discovery user-initiated

**Files:**
- Modify: `web/src/components/settings/updateStates.test.tsx`
- Modify: `web/src/components/settings/UpdateSettings.tsx`
- Modify: `web/src/store/updateStore.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/hooks/menuActions.ts`

- [x] **Step 1: Add a failing desktop-settings interaction test**

In `updateStates.test.tsx`, seed a desktop status with a spy for `checkDesktop`, render `UpdateSettings`, and assert the spy was not called. Click the button whose accessible text is `st('update.checkNow')`, then assert `checkDesktop` was called once. This measures whether opening the Settings panel itself contacts the updater.

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm --dir web exec vitest run src/components/settings/updateStates.test.tsx`
Expected: the new test fails because `DesktopUpdateSettings` calls `checkDesktop()` from its mount effect.

- [x] **Step 3: Remove implicit update checks and prompts**

Remove `checkUpdateOnStartup()` from `App.tsx` and delete the startup function from `updateStore.ts`. Remove both `UpdateNoticeDialog` mounts so a check result is presented in Settings rather than opening a global prompt. Remove the desktop mount effect from `DesktopUpdateSettings`. Change the `menu-check-updates` action to open Settings → About without invoking `checkDesktop()`; the Settings button remains the only action that starts a desktop release request. Keep download/install/relaunch actions unchanged.

- [x] **Step 4: Run focused tests and the frontend checks**

Run: `pnpm --dir web exec vitest run src/components/settings/updateStates.test.tsx src/store/updateStore.test.ts src/lib/desktop.golden.test.ts src/hooks/menuActions.test.tsx`
Expected: all focused tests pass; opening desktop Settings leaves `desktopChecked` false, and the button starts the check.

Run the focused tests plus `pnpm --dir web build && pnpm --dir web i18n:check`.
Expected: updater behavior, type/build checks, and translation consistency pass. The complete frontend suite currently has unrelated failures in documentation expectations, stale Tavotto branding expectations, a playground fingerprint, and an iconography timeout.

---

### Task 2: Register the signed Tauri updater and gate release builds

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/capabilities/main.json`
- Modify: `scripts/workbench_build.py`
- Modify: `tests/test_workbench_packaging.py`

- [x] **Step 1: Write failing build-configuration tests**

Add tests asserting that an ordinary build configuration has no updater artifacts, a release configuration enables updater artifacts and uses exactly `${brand.REPO_URL}/releases/latest/download/latest.json`, a foreign endpoint is rejected, a release tag must equal `v${WORKBENCH_VERSION}`, and a release version must be greater than the installed `1.0.0` baseline. Add cases proving missing public or private keys fail before invoking Tauri.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `python -m pytest -q tests/test_workbench_packaging.py`
Expected: new tests fail because release configuration and tag/key validation do not exist.

- [x] **Step 3: Implement a release-only Tauri config overlay**

Keep `src-tauri/tauri.conf.json` safe for normal builds. Add a helper in `workbench_build.py` that builds an overlay with `bundle.createUpdaterArtifacts: true`, the Plot Workbench endpoint from `engine.brand.REPO_URL`, and the public key from `TAURI_UPDATER_PUBLIC_KEY`. Require `TAURI_SIGNING_PRIVATE_KEY` for `--release-tag`; leave ordinary builds on the current installer-only path. Validate the tag as stable SemVer, require it to equal `WORKBENCH_VERSION`, and reject `v1.0.0` or lower because those users already have that version installed. Pass the overlay via Tauri CLI `--config` only for tag builds; the Tauri CLI reads the private signing key directly from its documented environment variables.

Register `tauri-plugin-updater` in Cargo and `main.rs`, and add only `updater:default` to `main-window` in `capabilities/main.json`. Do not add updater permissions to any remote-instance capability.

- [ ] **Step 4: Re-run packaging tests and Rust checks**

Run: `python -m pytest -q tests/test_workbench_packaging.py`
Expected: all release-overlay and rejection cases pass.

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: formatting is clean and the desktop shell compiles/tests with the updater plugin registered.
Local result: packaging tests pass; Cargo/Rust is not installed here, so formatting and Rust compilation remain for the Windows workflow.

---

### Task 3: Publish only complete signed Windows releases

**Files:**
- Modify: `scripts/make_updater_manifest.py`
- Modify: `tests/test_updater_manifest.py`
- Modify: `.github/workflows/workbench-build.yml`
- Create: `docs/workbench/updating.md`

- [x] **Step 1: Add failing manifest tests for fork ownership and release notes**

Add a Windows updater archive fixture named `Plot Workbench_1.0.1_x64-setup.nsis.zip`; assert the default manifest URL uses `brand.REPO_OWNER` and `brand.REPO_NAME`, the platform key is exactly `windows-x86_64`, the signature text is preserved, and a supplied notes file becomes `notes`. Keep explicit-owner tests for generic manifest construction.

- [x] **Step 2: Run the manifest tests and confirm they fail**

Run: `python -m pytest -q tests/test_updater_manifest.py`
Expected: the new default-owner and notes-file tests fail.

- [x] **Step 3: Generate the Plot Workbench manifest from signed artifacts**

Change manifest CLI defaults to the fork's `brand.REPO_OWNER` and `brand.REPO_NAME`; add `--notes-file` while retaining `--notes` for existing callers. Keep the manifest generator's hard error for missing `.sig` files and call it with `--require windows-x86_64` from the release workflow.

- [x] **Step 4: Add tag build and isolated publish jobs**

Extend `.github/workflows/workbench-build.yml` to run on `workbench/v1`, manual dispatch, and `v*` tags. The Windows build job keeps `contents: read`, runs backend, manifest, updater UI, packaging, and installer smoke tests, and uploads the installer, SHA-256, updater `.nsis.zip`, and `.sig`. Only tag builds pass `--release-tag` and signing variables. A dependent publish job has `actions: read` and `contents: write`, downloads this run's artifact with `gh run download`, asks GitHub for generated release notes, creates and validates `latest.json` with `--require windows-x86_64`, then creates the stable Release with all assets. Missing key, archive, signature, smoke result, manifest, or checksum must stop publication.

- [x] **Step 5: Document safe key setup and first upgrade**

Create `docs/workbench/updating.md` with the Tauri signer key-generation command; instructions to save the private key only as GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`, its optional passphrase as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the Base64-encoded full public key as repository Actions variable `TAURI_UPDATER_PUBLIC_KEY`; version/tag alignment; the `1.0.0` baseline requiring a later version such as `1.0.1`; and recovery via the ordinary installer. State explicitly that the private key must never be committed, uploaded as an artifact, or pasted into chat.

- [x] **Step 6: Verify updater contracts and packaging workflow**

Run: `python -m pytest -q tests/test_updater_manifest.py tests/test_workbench_packaging.py`
Expected: manifest generation, signing prerequisites, tag validation, and fork repository ownership pass.

Run Ruff check and format on the build/manifest scripts and updater tests, including `tests/test_workbench_release_workflow.py`.
Expected: no lint or format findings.

Run: `python -m pytest -q tests/test_workbench_packaging.py tests/test_updater_manifest.py tests/test_workbench_tavotto.py`
Expected: the focused fork build and updater tests pass together.

Run: `python scripts/build_browser_playground.py --check`
Expected: generated browser playground remains synchronized with `web/src`.

Local verification limits: Cargo/Rust is not installed here. The full frontend suite has unrelated failures noted above, and the local Python environment lacks optional `xlrd` for one legacy `.xls` test; GitHub Actions installs the `workbench` extra before running that test.

---

## Self-review

- Manual-only discovery, unknown-before-first-check state, signed install, Plot Workbench release URL, Windows-only stable manifest, release least privilege, first-update version floor, user recovery, and signing-key handling each have explicit tasks and verification steps.
- User project/data paths are not inputs to the workflow or uploaded artifacts; the build uses only repository source and generated application packages.
- The unsigned ordinary build remains available for local/branch validation; a tagged release fails closed when signing material is absent.
