# Codex chat dialog implementation plan

**Goal:** Make local Codex usable and provide a clear multi-turn dialog in template and Tavotto editing.

**Architecture:** Keep the existing local CLI bridge and staged/verified application path. Add bounded conversational context and validated parent proposals, and redesign the shared CodeAssistant using existing UI primitives.

- [x] Repair the app-only Codex executable setting using the existing validated setter; verify capabilities and a real synthetic task without touching Codex configuration.
- [x] Write failing backend tests for classified model errors, bounded history, normal replies and parent ownership/staleness. Implement in workbench/assistant.py and rendering.py; keep new API fields optional.
- [x] Redesign shared CodeAssistant and scoped CSS: centered expandable dialog, user/assistant messages, multiline composer, running/stop state, collapsed diffs/process. Add frontend tests for follow-up context and error/retry behavior.
- [x] Run Ruff before targeted backend tests, frontend tests/build/i18n, browser layout and both editor workflows, plus a real CLI multi-turn smoke. Review independently and preserve explicit apply/verification guards.
- [x] Show the verified local result and document results. Do not bump, tag, publish or distribute another installer without a new release decision.

Verification: the exact Windows workflow backend command collected 311 tests: 307 passed, 4 skipped for platform or opt-in requirements, none failed. The matching frontend suite passed 99 tests; production build, i18n, lint and playground drift check passed. Both actual Chromium workflows passed after two dialogue turns, explicit application, verification, save and reopen. Live Codex CLI 0.164 performed two synthetic turns under the user's existing login/model with no process proxy variables: the first answered without modifying code; the second made a staged code change. Codex config and auth files were byte-identical afterwards.

Review identified the Windows argv length limit for long conversations. Codex now receives its full UTF-8 prompt via an independent finite temporary stdin and `codex exec -`, never the parent sidecar stdin. A real Windows child verified the large Unicode payload and EOF, including a Chinese working directory. The ownership, stale source, stale data, history limit, finite stdin and CI enrollment tests were each manually mutated and observed failing before restoration. Independent review found the reported issue resolved with no further blocking issues.

An authenticated source preview uses isolated data under ignored `build/workbench-chat-verification/`; the visual test screenshot is saved there as `chat-dialog-preview.png`. The installed application's Codex path override was updated to its already-installed desktop CLI. After review, the user explicitly chose to release 1.2.1 and to keep the local 1.2.0 installation for an update check.
