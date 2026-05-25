# Smart Dashboard & Advanced Duplicate Finder

A local Stashapp plugin for advanced visual duplicate detection and dashboard recommendation generation.

**Author:** Jaulustus  
**Repository:** https://github.com/Jaulustus/smart-dashboard

## Overview

Smart Dashboard & Advanced Duplicate Finder adds two local automation tasks to Stash:

- **Advanced Duplicate Scan** analyzes video files with perceptual hashing to detect visually similar scenes, even when resolution, bitrate, or compression differ.
- **Dashboard Recommendations** analyzes local watch history through the Stash GraphQL API and generates recommendation data for forgotten favorites and smart suggestions.

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

The generated output is written to `recommendations.json`.

## Tech Stack

- Python 3
- Stash GraphQL API
- `requests`
- `opencv-python`
- `numpy`
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

2. Install the required Python packages.

   ```bash
   pip install requests opencv-python numpy
   ```

   If Stash uses a specific Python executable or virtual environment, install the packages into that same environment.

3. Open the Stash settings UI and click **Reload Plugins**.

4. Confirm that **Smart Dashboard & Advanced Duplicate Finder** appears in the Stash plugins list.

## Usage

The plugin exposes its functionality through the native Stash **Tasks** menu.

Available tasks:

- **Start Advanced Duplicate Scan / Erweiterte Duplikatsuche starten**
- **Update Dashboard Recommendations / Dashboard-Empfehlungen aktualisieren**

When a task is started, Stash runs the plugin backend script directly and passes the selected task argument to it.

The plugin writes live progress and diagnostic output to the native Stash log window through `stderr`, keeping the task result output compatible with Stash's raw plugin interface.

## Generated Files

The plugin creates local files in its own plugin directory:

- `cache.db`  
  SQLite cache used by the duplicate scanner to store video hash chains.

- `duplicates_report.json`  
  Report containing suspected duplicate scene pairs, confidence scores, compared samples, and scene metadata.

- `recommendations.json`  
  Report containing dashboard recommendation data such as Forgotten Gems and Smart Suggestions.

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
- If Python dependencies are missing, the plugin reports the missing packages in the Stash task output.

## License

No license has been specified yet.
