# Smart Dashboard & Advanced Duplicate Finder

A local Stashapp plugin for advanced visual duplicate detection and dashboard recommendation generation.

**Author:** Jaulustus  
**Repository:** https://github.com/Jaulustus/smart-dashboard

## Overview

Smart Dashboard & Advanced Duplicate Finder adds local automation and a Cinematic dashboard to Stash:

- **Advanced Duplicate Scan** analyzes video files with perceptual hashing to detect visually similar scenes, even when resolution, bitrate, or compression differ.
- **Dashboard Recommendations** analyzes local watch history through the Stash GraphQL API and generates recommendation data for forgotten favorites and smart suggestions.
- **Stash Cinematic UI** adds a native React-powered dashboard route directly inside the Stash web interface.
- **Short-Video Cleanup** lets users enter a duration in the dashboard and remove matching scene records from Stash while keeping the original files on disk.

The plugin runs locally, communicates with the local Stash GraphQL API, and writes generated reports directly into the plugin directory.

## Features

### Advanced Duplicate Scan

The duplicate scanner samples frames from videos and generates perceptual hashes using OpenCV and DCT-based pHash logic. These hashes are compared across the library to identify likely visual duplicates.

Key details:

- Uses `opencv-python` and `numpy` for video frame sampling and DCT processing.
- Stores reusable hash data in a local SQLite cache: `cache.db`.
- Avoids unnecessary rescans when files have not changed.
- Detects visual matches across different encodes, resolutions, and compression settings.
- Writes suspected duplicate candidates to `duplicates_report.json`.

### Dashboard Recommendations

The dashboard task queries the Stash GraphQL API and analyzes local viewing behavior to build recommendation data.

Generated recommendation groups include:

- **Forgotten Gems:** highly rated scenes that have not been watched recently.
- **Smart Suggestions:** scenes matched against local viewing preferences such as tags, studios, ratings, and play history.
- **Library Spotlight:** fallback recommendations from the local scene library when ratings or watch history are sparse.

The generated output is written to `recommendations.json`.

### Native Stash Cinematic UI

The plugin registers `smart_dashboard.js` and `smart_dashboard.css` as native Stash UI assets. The frontend reads `recommendations.json` through Stash's plugin asset endpoint and renders a cinematic dashboard directly inside the Stash React application.

The dashboard includes:

- A **Cinematic** button in the standard Stash navigation bar.
- Hero billboard with a featured scene.
- Horizontal rows for Library Spotlight, Forgotten Gems, Top Rated, Recently Watched, and Smart Suggestions.
- Duplicate scan results from `duplicates_report.json`.
- Hoverable scene cards with cover art, rating, tags, resolution, and direct scene links.
- Library Tools section with a guarded short-video cleanup action.
- Title fallback logic that uses the Stash title first, then the scene file name if the title is empty or `Untitled`.

## Tech Stack

- Python 3
- Stash GraphQL API
- `requests`
- `opencv-python`
- `numpy`
- JavaScript/CSS Stash UI plugin assets
- SQLite

## Prerequisites

Before using the plugin, make sure:

- Stash is installed and running.
- Python 3 is available from the command line.
- The local Stash GraphQL API is reachable, usually at `http://localhost:9999/graphql`.
- The required Python packages are installed in the Python environment used by Stash.

## Installation

1. Place the plugin folder into your Stash plugins directory.

   Example:

   ```text
   plugins/local/smart-dashboard
   ```

2. Open the Stash settings UI and click **Reload Plugins**.

3. Open the **Cinematic** dashboard from the Stash navigation bar.

   On first open, the dashboard automatically starts the setup operation once for that browser profile. This installs the required Python packages using `requirements.txt`. Setup can also be started manually from the **Plugin Tasks** section inside Cinematic.

   For manual installation outside the Stash UI, run:

   ```bash
   pip install -r requirements.txt
   ```

   If Stash uses a specific Python executable or virtual environment, install the packages into that same environment.

4. Confirm that **Smart Dashboard & Advanced Duplicate Finder** appears in the Stash plugins list.

## Stash Plugin Manifest

The plugin manifest is `smart_dashboard.yml`. Stash uses a strict YAML schema for plugin manifests, so unsupported top-level fields such as `id` or `author` must not be added to the file.

The plugin ID is derived from the manifest filename. Because the file is named `smart_dashboard.yml`, the internal Stash plugin ID is:

```text
smart_dashboard
```

## Usage

The plugin exposes its functionality through the native **Cinematic** dashboard instead of the standard Stash **Tasks** menu. This keeps setup, recommendations, duplicate scan, and cleanup in one place.

When an operation is started from Cinematic, Stash runs the plugin backend script directly and passes the selected mode to it.

The plugin writes live progress and diagnostic output to the native Stash log window through `stderr`, keeping the task result output compatible with Stash's raw plugin interface.

The native dashboard is available at:

```text
http://localhost:9999/?smart_dashboard=cinematic
```

This URL first loads the normal Stash UI, then the plugin JavaScript opens the Cinematic Dashboard as an in-app overlay.

After the UI assets are loaded, a **Cinematic** button is inserted into the standard Stash navigation bar.

On the first Cinematic open in a browser profile, the UI automatically starts **Setup / Install Dependencies** once. Cinematic also includes a **Plugin Tasks** section for manually starting Setup, Dashboard Recommendations, and the Advanced Duplicate Scan.

If `recommendations.json` is missing, the Cinematic UI temporarily falls back to live GraphQL scene data. Use **Recommendations neu suchen** to rebuild the local report when needed.

The Cinematic header also shows the total number of videos currently known to Stash and a rough estimate for how long recommendation generation should take. This count is refreshed live through GraphQL, so it is not limited to the 50-item recommendation rows. The **Recommendations neu suchen** button rebuilds `recommendations.json`, which is useful after removing scenes from Stash.

Duplicate scan results are shown in the **Duplicate Results** section. The section reads `duplicates_report.json`, displays the latest scan metadata, and lists suspected duplicate pairs with confidence, average distance, compared samples, scene titles, paths, and direct Stash scene links.

Short-video cleanup is launched only from the **Library Tools** section in the dashboard. It is intentionally not shown as a normal Stash task button because native task buttons cannot display input fields. Enter a duration such as `0:30`, `1:15`, or `90`; the dashboard validates it and removes matching scene records from Stash with dynamic arguments. Original video files are left on disk.

## Generated Files

The plugin creates local files in its own plugin directory:

- `cache.db`  
  SQLite cache used by the duplicate scanner to store video hash chains.

- `duplicates_report.json`  
  Report containing suspected duplicate scene pairs, confidence scores, compared samples, and scene metadata.

- `recommendations.json`  
  Report containing dashboard recommendation data such as Library Spotlight, Forgotten Gems, Top Rated, Recently Watched, and Smart Suggestions. Scene cards include display metadata such as title, cover path, rating, tags, resolution, and file-name fallback data when available.

These files are generated locally and are not sent to any external service.

## Configuration

By default, the plugin connects to:

```text
http://localhost:9999/graphql
```

The backend can also use Stash-provided plugin payload data or environment variables when available.

Supported environment variables include:

- `STASH_GRAPHQL_URL`
- `STASH_GRAPHQL_ENDPOINT`
- `STASH_URL`
- `STASH_API_KEY`
- `STASH_APIKEY`
- `STASH_API_TOKEN`

## Logging

All diagnostic logging is written to `stderr` with flushing enabled so that Stash can display live progress in its UI logs.

Standard output is reserved for the raw JSON response expected by Stash.

## Notes

- The first duplicate scan can take time because every eligible video needs to be sampled and hashed.
- Later scans should be faster when the SQLite cache can be reused.
- Very large libraries may produce a large number of pairwise comparisons.
- If Python dependencies are missing, the plugin reports the missing packages in the Stash operation output.

## License

No license has been specified yet.
