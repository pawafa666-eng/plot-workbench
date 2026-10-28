# Updater system proxy implementation plan

> Execute in this session, in the user's requested workspace on workbench/v1.

**Goal:** Repair Windows proxy support and replace/install verified v1.2.0.

**Architecture:** Feature-unify the updater's existing reqwest 0.13 client with system-proxy; keep raw native failure details in the current UI. Preserve manual checks, TLS, minisign, session auth and all project data.

**Tech stack:** Tauri 2, reqwest 0.13, React/Zustand, pytest, Vitest, GitHub Actions, NSIS.

- [x] Add a parsed-TOML regression in tests/test_workbench_desktop.py requiring the shared reqwest system-proxy feature. Add native string check/download failures to web/src/store/updateStore.test.ts. Run each and verify failures.
- [x] Add `reqwest = { version = "0.13", default-features = false, features = ["system-proxy"] }` to src-tauri/Cargo.toml; regenerate Cargo.lock with Cargo and inspect its resolved features. Preserve string errors in both desktop update failure handlers.
- [x] Update docs/workbench/updating.md and releases/v1.2.0.md. Run Ruff, targeted pytest, frontend update/bridge tests, lint, translations and build. Rebuild the playground and confirm regression tests detect removed fixes.
- [x] Back up the existing release/assets/tag in ignored build/updater-proxy-v1.2.0; commit the verified fix. Replace only v1.2.0 and push the signed-release tag. Existing workflow builds and verifies the installer and draft.
- [x] Independently verify new release hashes, minisign signature and manifest URLs; publish the validated draft. Install into the existing D:\Plot Workbench location, launch and manually check updates through the Windows proxy. Verify version, signed package provenance and preservation of local projects/templates.

Local evidence: the new proxy test and both native string-error tests failed before the fix, then passed. All fork backend tests and updater manifest checks passed; 54 targeted frontend tests passed. Full Ruff, frontend lint, translations, production build and playground drift check passed. Independent review confirmed a single reqwest 0.13.4 feature graph with system-proxy enabled, unchanged TLS/signature handling, no existing package version changes, and both updater request paths using that implementation.

Release and installation evidence (2026-10-28): source/tag commit `b9086507633cccd22a4e8ea67574296b84a71527`; Windows run `40613149410` completed successfully, including installed smoke, signing-key pairing and validated draft. Old release `425487485` was backed up and removed; replacement release `426164166` was independently verified and published as stable/latest v1.2.0 with all five assets. Anonymous manifest bytes match the verified file; the public installer returns HTTP 200 with the correct size. Installer SHA-256: `d06ade6a10e949549296dc3fb7f9f0c3acca0a2564403a73f6b3f0fcd0b699cb`.

The installed `D:\Plot Workbench\PlotWorkbench.exe` and uninstall registry both report 1.2.0. Launched without HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY, using the existing Windows proxy setting. Actual UI check at 09:25 Asia/Singapore displayed `2026/10/28 09:25 · 没有新版本`, with no error. Both local data snapshots (65 default-location files and 61 active-root files) remained byte-identical after installation and launch. Operational evidence and old assets stay in ignored `build/updater-proxy-v1.2.0`; no user data enters Git.
