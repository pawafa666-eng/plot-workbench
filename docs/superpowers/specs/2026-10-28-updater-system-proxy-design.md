# Windows updater system proxy repair

The user approved repairing the diagnosed updater connection failure, replacing the existing v1.2.0 release, and upgrading the local installation. Keep the version at 1.2.0 and retain unrelated historical releases.

Enable reqwest's `system-proxy` feature on the same 0.13 dependency used by tauri-plugin-updater. This lets both manifest checks and installer downloads use Windows proxy configuration without hardcoding a proxy address, changing global settings, replacing the update endpoint, or relaxing TLS/signature checks. Retain native IPC string errors in the existing update status UI.

Verify the declaration and resolved Cargo feature graph, regression-test check/download error handling, and build the signed Windows package with the existing CI and installer smoke tests. Back up the old release metadata and assets, replace only the old v1.2.0 release/tag after local checks, validate the new draft and signatures, publish under the user's explicit authorization, then install and check the new app on this machine's system proxy.

Same-version replacement is explicitly requested: clients already running 1.2.0 need the replacement installer because SemVer checks do not regard 1.2.0 as newer than 1.2.0. The local machine currently has 1.1.2.
