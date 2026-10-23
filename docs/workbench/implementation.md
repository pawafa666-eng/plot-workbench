# Plot Workbench v1 implementation

Plot Workbench is a Windows desktop fork based on Tavotto v0.18.0, commit
`71c72fdb48f28411bd76a021e5d78d2005e76c8a`. Product branding, application ID,
configuration directories and GitHub repository are independent. The fork keeps
the AGPL-3.0-only license and upstream attribution.

## Application structure

- `src/tavotto/workbench/data.py` parses Excel and CSV, selects inclusive physical
  ranges, preserves typed values and source coordinates, and implements table
  transformations and schema checks.
- `src/tavotto/workbench/store.py` stores portable project manifests, plot and
  template revisions, categories, favorites and recoverable deletions.
- `src/tavotto/workbench/api.py` provides the authenticated local HTTP API.
- `src/tavotto/workbench/rendering.py` runs isolated Python jobs and embedded
  Tavotto sessions, then commits only validated render results.
- `src/tavotto/workbench/runner.py` is executed by the app-private scientific
  Python runtime; it renders tightly cropped 600 dpi PNG and vector SVG/PDF.
- `web/src/workbench/` contains the Chinese project, template, import and editing
  interface. The Tavotto canvas is embedded in the same desktop window.

Plot code runs as a normal Matplotlib script and may produce multiple Figures.
Function-only v1 templates can still implement `build_figure(data)` and optional
`example_data()`. `execution.py` collects distinct Figures in creation order,
including closed figures, inside the existing safe worker. Imported
tables are copied into the project; data is never linked to a changing source
file. The table preview is capped at 50 × 50 cells while the full selection is
kept for rendering.

The first verified Tavotto edit changes a plot into `TAVOTTO_ONLY`: its base code,
data and template binding are frozen. Every later Tavotto edit replays the
complete saved patch list against that original code in a fresh worker. Generated
replay scripts are exports and never become the next session's base code.

## Build and verification

The `Plot Workbench Windows` workflow builds the private Python runtime and NSIS
installer on a Windows runner. It runs backend tests, frontend tests, lint checks,
installs into a non-ASCII path with system Python removed from `PATH`, exercises
the authenticated project/data/render/export API, checks the desktop shell, and
verifies uninstall before uploading the installer artifact.

Each project chooses an existing working folder; owned files live in its
`.plot-workbench/` child. Folder manifests use relative paths and legacy v1
projects remain supported. Per-output patch maps retain independent Tavotto edits
while the common original source stays frozen. Global template storage and the
recent project registry remain in the chosen library directory. User data is not
included in the public repository or installer.
