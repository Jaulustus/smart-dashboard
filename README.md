# Smart Dashboard & Advanced Duplicate Finder

A local Stashapp plugin with a Cinematic dashboard, visual duplicate detection, local recommendations, and an MCP agent for external AI tools.

**Author:** Jaulustus  
**Repository:** https://github.com/Jaulustus/smart-dashboard

## Quick start (you received the GitHub link)

> **Deutsch:** Du hast den Link zum Plugin bekommen? Installiere den Ordner unter Stash **Einstellungen → System → Plugin-Pfad**, lade Plugins neu, öffne **MCP-Server** in Stash, warte auf Index + kopiere die MCP-Config. Terminal ist normalerweise **nicht** nötig. Details unten.

This repository is a **Stash plugin** (not a standalone app). It adds **Cinematic** (dashboard + duplicates + recommendations) and an **MCP agent** so tools like **Cursor**, **Claude Desktop**, or **OpenClaw** can search and edit your library **on the same machine as Stash**.

### For users (step by step)

| Step | What to do |
|------|------------|
| 1 | Copy or clone into your Stash plugins folder (see [Installation](#installation)) — usually `…/plugins/community/smart-dashboard` or `…/plugins/local/smart-dashboard` |
| 2 | In Stash: **Settings → Plugins → Reload Plugins** — version should show **0.3.0** |
| 3 | Open **Cinematic** in the nav bar for the dashboard, or **MCP-Server** for the AI agent |
| 4 | In MCP UI: wait until setup shows ready (or click **Scan full library** once) |
| 5 | Click **Copy MCP config** and paste into your AI client ([Connect Cursor](#connect-cursor), [Claude](#connect-claude-desktop), etc.) |
| 6 | Restart the AI app / reload MCP servers — tools named `stash_*` should appear |

**You do not need to run `pip` manually** unless a Stash plugin task failed (check **Settings → Logs**). Updating the plugin to a newer **0.3.x** release does **not** force a full reinstall if `vendor/` and `agent_library.db` already exist.

### Commands (optional — server / SSH admin)

Replace `$STASH_PLUGINS` with your real path from **Settings → System → Plugin path** (examples use `community`; use `local` if you install there).

```bash
# Clone into the community plugins folder (Linux/macOS)
STASH_PLUGINS="${HOME}/.stash/plugins/community"
git clone https://github.com/Jaulustus/smart-dashboard.git "${STASH_PLUGINS}/smart-dashboard"
```

```bash
# Or update an existing clone
cd "${HOME}/.stash/plugins/community/smart-dashboard"
git pull
```

```bash
# Manual dependency install (only if Stash tasks fail — normally automatic)
cd "${HOME}/.stash/plugins/community/smart-dashboard"
python3 -m pip install -r requirements.txt -r requirements-agent.txt --target ./vendor
```

```bash
# Sanity check after setup (files should exist on the Stash server)
cd "${HOME}/.stash/plugins/community/smart-dashboard"
ls -la vendor/ agent_library.db install_state.json setup_log.txt 2>/dev/null
python3 -c "import sys; sys.path.insert(0,'vendor'); import mcp, requests; print('deps OK')"
```

```powershell
# Windows — example paths
cd "$env:USERPROFILE\.stash\plugins\community\smart-dashboard"
git pull
python -m pip install -r requirements.txt -r requirements-agent.txt --target .\vendor
```

Then in Stash: **Reload Plugins**, open **MCP-Server**, refresh the log panel if needed.

### What your AI can do for you (with MCP connected)

> **Deutsch:** Mit verbundenem MCP kann deine KI **lokal** auf deine Stash-Bibliothek zugreifen — suchen, Statistiken, Tags/Darsteller/Studios pflegen, Bewertungen setzen, Duplikat-Reports lesen und den Index neu bauen. **Keine** Dateien auf der Festplatte löschen (nur Metadaten in Stash ändern). Alles bleibt auf deinem Rechner; nur das, was du in den Chat schreibst, geht an den KI-Anbieter.

Once **Cursor**, **Claude Desktop**, **OpenClaw**, or another MCP client is connected to `stash_mcp_server.py`, the assistant can help with tasks such as:

| You ask (examples) | What the AI does via MCP |
|--------------------|---------------------------|
| *“How many scenes do I have?”* | Calls `stash_get_library_stats` or `stash_agent_library_overview` |
| *“Find scenes with tag X and performer Y”* | `stash_agent_chat`, `stash_agent_search_index`, or `stash_search_scenes` |
| *“Show details for scene 12345”* | `stash_get_scene` (live data + Stash URLs) |
| *“Add tag … and rate 80%”* | `stash_update_scene` with `tag_mode: "add"` |
| *“Rename / fix title and studio”* | `stash_update_scene` (title, `studio_name`, etc.) |
| *“What duplicates were found?”* | `stash_list_duplicate_groups` (after you ran **Duplicate Scan** in Cinematic) |
| *“Refresh the index after I imported 500 scenes”* | `stash_rebuild_agent_index` |
| *“List tags matching ‘outdoor’”* | `stash_search_tags` (same for performers / studios) |

**The AI does not (via these MCP tools):** delete video files on disk, run the pHash duplicate **scan** itself (only **read** the report), or change Stash system settings. **Cinematic** in Stash still handles duplicate scanning, recommendations refresh, and short-video cleanup in the browser UI.

### MCP tools the AI can run (command reference)

All tools are invoked by the AI client as **`stash_*`** MCP tools (not shell commands). They return **JSON text** for the model to read.

| MCP tool | What it does | Typical use |
|----------|----------------|-------------|
| `stash_list_mcp_tools` | Lists all **`stash_*`** tools; clarifies **`agent_library.db` is not a command registry** | Agents/OpenClaw looking for “commands in the DB” |
| `stash_agent_library_overview` | Scene/tag/performer/studio counts and samples from **`agent_library.db`** | First check: is the index ready? |
| `stash_agent_chat` | Natural-language search on the **local index** (fast) | *“Find forgotten high-rated outdoor scenes”* |
| `stash_agent_search_index` | Direct text search on the index (title, path, tags, performers, studio) | Precise keyword search |
| `stash_rebuild_agent_index` | Full library scan → rebuilds **`agent_library.db`** | After large imports or metadata bulk changes |
| `stash_search_scenes` | Live **GraphQL** search (filters: query, tags, performers, studio, sort) | Up-to-the-minute library query |
| `stash_get_scene` | Full metadata for one scene ID + Stash page/stream URLs | Before editing or summarizing one video |
| `stash_update_scene` | Edit scene in Stash: title, details, date, **rating100** (0–100), organized, studio, **tags**, **performers** | Metadata cleanup, tagging, rating |
| `stash_search_tags` | Search tag names (paginated) | Resolve tag names before updates |
| `stash_search_performers` | Search performer names | Cast lists, linking performers |
| `stash_search_studios` | Search studio names | Studio assignment |
| `stash_get_library_stats` | Total scene count + Stash base URL | Quick library size check |
| `stash_list_duplicate_groups` | Read **`duplicates_report.json`** from Cinematic duplicate scan | Review visual duplicate candidates |

**`stash_update_scene` parameters (important for the AI):**

- **Tags / performers:** `tag_names` / `performer_names` with `tag_mode` / `performer_mode`:
  - **`add`** — append (safe default; does not remove existing tags)
  - **`set`** — replace entire list (must send **all** IDs/names you want to keep)
  - **`remove`** — remove listed tags/performers
- **Rating:** `rating100` (0–100, Stash scale; omit or `-1` to leave unchanged)
- **Studio:** `studio_name` (creates studio if missing) or `studio_id`; `clear_studio: true` to clear
- **Other:** `title`, `details`, `date`, `organized` (boolean)

**Recommended order for the AI:**

1. `stash_agent_library_overview` — confirm index is populated  
2. Search → `stash_agent_chat` and/or `stash_search_scenes`  
3. Details → `stash_get_scene`  
4. Edit → `stash_update_scene` (prefer **`add`** for tags/performers)  
5. After library changes → `stash_rebuild_agent_index`  

#### Example MCP tool calls (parameters for the AI)

> **Deutsch:** Das sind **keine** Shell-Befehle zum Eintippen im Terminal. In Cursor/Claude ruft die KI diese Tools selbst auf. Die Tabelle zeigt, **welche Argumente** jedes Tool erwartet — nützlich für Prompts und für Entwickler.

The AI client sends these as MCP tool invocations (name + JSON arguments):

```text
# 1) Library overview (local index)
Tool: stash_agent_library_overview
Arguments: {}

# 2) Natural-language search on the index
Tool: stash_agent_chat
Arguments: { "message": "scenes with tag outdoor and rating above 80", "limit": 12 }

# 3) Keyword search on the index
Tool: stash_agent_search_index
Arguments: { "query": "documentary", "limit": 20 }

# 4) Rebuild index after imports
Tool: stash_rebuild_agent_index
Arguments: {}

# 5) Live GraphQL scene search
Tool: stash_search_scenes
Arguments: {
  "query": "summer",
  "tag_names": ["Outdoor"],
  "performer_names": [],
  "studio_name": "",
  "page": 1,
  "per_page": 40,
  "sort": "date",
  "direction": "DESC"
}

# 6) One scene by ID (replace 123 with a real scene id)
Tool: stash_get_scene
Arguments: { "scene_id": "123" }

# 7) Add tags and set rating (safe: tag_mode add)
Tool: stash_update_scene
Arguments: {
  "scene_id": "123",
  "tag_names": ["Documentary", "Favourite"],
  "tag_mode": "add",
  "rating100": 80
}

# 8) Set title and studio
Tool: stash_update_scene
Arguments: {
  "scene_id": "123",
  "title": "My corrected title",
  "studio_name": "Example Studio"
}

# 9) Search tags / performers / studios
Tool: stash_search_tags
Arguments: { "query": "out", "page": 1, "per_page": 40 }

Tool: stash_search_performers
Arguments: { "query": "jane", "page": 1, "per_page": 40 }

Tool: stash_search_studios
Arguments: { "query": "example", "page": 1, "per_page": 40 }

# 10) Library size (GraphQL)
Tool: stash_get_library_stats
Arguments: {}

# 11) Duplicate report (run Cinematic duplicate scan first)
Tool: stash_list_duplicate_groups
Arguments: { "limit": 20 }
```

**Example chat prompts** (user writes this; the AI picks the tools above):

```text
Call stash_agent_library_overview and tell me scene, tag, and performer counts.

Use stash_agent_chat to find my highest-rated scenes I have not watched recently.

Search live with stash_search_scenes for title containing "vacation" and tag_names ["Travel"].

Get scene 456 with stash_get_scene, then add tag "Archive" with stash_update_scene (tag_mode add only, rating100 90).

I imported 200 new files — run stash_rebuild_agent_index, then stash_agent_library_overview again.

Show duplicate groups from stash_list_duplicate_groups after my last duplicate scan.
```

#### Shell commands (Stash plugin tasks — optional admin)

These run on the **Stash server** (same machine as Stash), not inside Cursor. Use when debugging without an AI client:

```bash
cd "${HOME}/.stash/plugins/community/smart-dashboard"
export STASH_GRAPHQL_URL="http://127.0.0.1:9999/graphql"
# optional if Stash uses an API key:
# export STASH_API_KEY="your-key"

# Read setup log + refresh install_state / setup_log_snapshot (lightweight)
python3 smart_dashboard.py agent_setup_log

# Index statistics (needs agent_library.db)
python3 smart_dashboard.py agent_index_stats

# Install state probe (writes install_state.json)
python3 smart_dashboard.py agent_install_state
```

In normal use, prefer **Stash → Settings → Plugins → Tasks** (*Install MCP agent dependencies*, *Build agent library index*) or the **MCP-Server** UI instead of the snippets above.

Full reference (troubleshooting, env vars): [MCP tools reference](#mcp-tools-reference) below.

### For AI agents (when the user shares this link or README)

If you are an AI assistant helping someone who was sent  
`https://github.com/Jaulustus/smart-dashboard` — use this as ground truth:

1. **Scope** — Local Stash plugin; MCP server is `stash_mcp_server.py` (stdio). Library data and `agent_library.db` stay on the user's machine; only chat text goes to your provider.
2. **Do not** tell them to delete `vendor/` or `agent_library.db` for a routine **0.3.0 → 0.3.x** update. Reinstall only if dependencies or the index are actually missing.
3. **Best config source** — Stash UI → **MCP-Server** → **Copy MCP config** (absolute paths + GraphQL URL + API key). Fallback: `mcp-config.cursor.json` with `REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR` replaced using **Settings → System → Plugin path** + `/smart-dashboard/`.
4. **Prerequisites** — Stash running; plugin reloaded; MCP deps in `vendor/`; index built (`agent_library.db` with scenes). UI scan or `stash_rebuild_agent_index` if searches return nothing.
5. **Capabilities** — Use the [MCP tools table](#mcp-tools-the-ai-can-run-command-reference) above. Prefer index tools (`stash_agent_*`) for speed; use GraphQL tools (`stash_search_scenes`, `stash_get_scene`, `stash_update_scene`) when data must be live or when editing.
6. **Safety** — On `stash_update_scene`, default to `tag_mode` / `performer_mode` **`add`**. Warn before **`set`** (replaces full lists). Do not claim you deleted files unless the user used Cinematic cleanup separately.
7. **Troubleshooting** — Empty MCP UI log → `setup_log_snapshot.json`; Stash log “Error” lines for MCP are often normal (stderr); wrong MCP path → `community` vs `local`; GraphQL errors → `STASH_GRAPHQL_URL` / `STASH_API_KEY`.

**Example prompts to suggest to the user:**

- *“Open Stash → MCP-Server, confirm the index shows your scene count, then paste the copied MCP config into Cursor.”*
- *“Call `stash_agent_library_overview` and summarize my library.”*
- *“Use `stash_agent_chat` to find scenes matching … and give me scene IDs and Stash links.”*
- *“Add tag ‘Documentary’ to scene 42 with `tag_mode` add only.”*
- *“After I added new files, run `stash_rebuild_agent_index`.”*

More detail: [Agent integration](#agent-integration-optional) · German short guide: [MCP_AGENT_CONNECT.md](MCP_AGENT_CONNECT.md)

## Overview

Smart Dashboard & Advanced Duplicate Finder adds local automation and a Cinematic dashboard to Stash:

- **Advanced Duplicate Scan** analyzes video files with perceptual hashing to detect visually similar scenes, even when resolution, bitrate, or compression differ.
- **Dashboard Recommendations** analyzes local watch history through the Stash GraphQL API and generates recommendation data for forgotten favorites and smart suggestions.
- **Stash Cinematic UI** adds a native React-powered dashboard route directly inside the Stash web interface.
- **MCP Agent** connects external AI agents (Cursor, Claude Desktop, OpenClaw, …) to your library via a local index and MCP tools.
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
- **Cinematic Search** for title, filename, and tag searches across the full Stash library.
- An in-dashboard video player for opening scene cards without leaving Cinematic.
- A **From Your Top Tags** row based on the weighted tag profile from local viewing behavior.
- **Random Picks** with six live random scenes pulled from the full Stash library.
- Duplicate scan results from `duplicates_report.json`.
- Hoverable scene cards with cover art, rating, tags, resolution, and direct scene links.
- Dashboard UI follows the **language configured in Stash** (Settings → Interface → Language), with English and German fully translated and other locales falling back where needed.
- Library Tools section with a guarded short-video cleanup action.
- Title fallback logic that uses the Stash title first, then the scene file name if the title is empty or `Untitled`.

### MCP Agent (in Stash + external agents)

- **MCP-Server** navigation button opens a Cinematic-style agent hub: local chat, library scan, and copy-paste MCP config.
- Builds **`agent_library.db`** (SQLite index of scenes, tags, performers, studios) for fast search.
- **`stash_mcp_server.py`** exposes MCP tools for Cursor, Claude Desktop, OpenClaw, and other MCP clients.
- UI and docs follow the **language configured in Stash** (see [MCP](#mcp-model-context-protocol) below).

## Tech Stack

- Python 3
- Stash GraphQL API
- `requests`
- `opencv-python`
- `numpy`
- JavaScript/CSS Stash UI plugin assets
- SQLite (`cache.db`, `agent_library.db`)
- `mcp` (Python MCP server for external agents)

## Prerequisites

Before using the plugin, make sure:

- Stash is installed and running.
- Python 3 is available from the command line.
- The local Stash GraphQL API is reachable, usually at `http://localhost:9999/graphql`.
- The required Python packages are installed in the Python environment used by Stash.

## Installation

1. Clone or copy this repository into your Stash **plugins** directory (see **Settings → System → Plugin path**).

   Typical layouts (replace `$HOME` with your Stash runtime user — **not** hardcoded in the plugin):

   | Install type | Example (Linux/macOS) | Example (Windows) |
   |--------------|----------------------|-------------------|
   | Local / manual | `$HOME/.stash/plugins/local/smart-dashboard` | `%USERPROFILE%\.stash\plugins\local\smart-dashboard` |
   | Community index | `$HOME/.stash/plugins/community/smart-dashboard` | `%USERPROFILE%\.stash\plugins\community\smart-dashboard` |

   The folder name should match the repo (`smart-dashboard`). The plugin resolves paths from **Stash settings** (database path, plugin path, config directory), not from a fixed username or host.

2. Open the Stash settings UI and click **Reload Plugins**.

3. Open the **Cinematic** dashboard from the Stash navigation bar.

   On first load, the plugin automatically queues Stash background tasks to install Python dependencies into the plugin `vendor/` folder (`requirements.txt` and `requirements-agent.txt`). No terminal is required for normal use.

   Optional (admins only): run the same install from **Settings → Plugins → Tasks**, or inspect **Settings → Logs** if a task fails.

4. Confirm that **Smart Dashboard & Advanced Duplicate Finder** appears in the Stash plugins list.

## Stash Plugin Manifest

The plugin manifest is `smart_dashboard.yml`. Stash uses a strict YAML schema for plugin manifests, so unsupported top-level fields such as `id` or `author` must not be added to the file.

The plugin ID is derived from the manifest filename. Because the file is named `smart_dashboard.yml`, the internal Stash plugin ID is:

```text
smart_dashboard
```

### Plugin not listed after Reload Plugins

Stash only accepts fields documented in the [plugin manifest](https://docs.stashapp.cc/in-app-manual/plugins/). **Do not add** top-level keys such as `id` or `author` to `smart_dashboard.yml` — with strict YAML parsing you will see:

```text
Error loading plugin ...\smart_dashboard.yml: yaml: unmarshal errors:
  line 1: field id not found in type plugin.Config
```

**Checklist:**

1. Confirm the folder is under **Settings → System → Plugin path** (e.g. `…/plugins/local/smart-dashboard` or `…/plugins/community/smart-dashboard`).
2. The manifest must be named `smart_dashboard.yml` (plugin ID `smart_dashboard`).
3. After copying files, click **Reload Plugins** and read the Stash log for `Error loading plugin` or `plugin ID smart_dashboard already exists` (duplicate copy elsewhere under `plugins/`).
4. Required UI files must be present: `smart_dashboard_i18n.js`, `smart_dashboard.js`, `smart_dashboard.css`, `smart_dashboard.py`, `smart_dashboard_messages.py`.
5. After upload, the plugin list should show the version from `smart_dashboard.yml` (currently **0.3.0**) and an updated **description** (Cinematic dashboard, duplicates, recommendations, MCP agent). If it still shows an older version, click **Reload Plugins** and hard-refresh the browser. Stash caches plugin metadata until reload.
6. **Plugin version bumps do not trigger reinstall.** Setup is skipped when `vendor/`, `agent_library.db`, and import checks already succeed. The plugin writes `install_state.json` on disk to remember that; the version field there is informational only.
7. **MCP setup log in the UI** reads `setup_log_snapshot.json` / `setup_log.txt` over HTTP while Stash plugin tasks are busy (no need to wait for an idle subprocess).

### Stash UI blank / crash with plugin enabled

Older builds used Node-style `global` in browser JS and could blank the entire Stash UI. **0.2.7+** uses `window` only, avoids patching Stash’s React navbar (which caused React error #130), and wraps startup in `try/catch`.

**Recovery without the UI:** rename the manifest on the server:

```bash
cd "$HOME/.stash/plugins/local/smart-dashboard"   # or …/community/smart-dashboard
mv smart_dashboard.yml smart_dashboard.yml.off
```

Reload the browser — Stash works again. Copy fixed files from this repo, restore `smart_dashboard.yml`, then **Reload Plugins** and hard-refresh (`Ctrl+Shift+R`).

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

If `recommendations.json` is missing, the Cinematic UI temporarily falls back to live GraphQL scene data. Use **Refresh Recommendations** to rebuild the local report when needed.

The Cinematic header also shows the total number of videos currently known to Stash and a rough estimate for how long recommendation generation should take. This count is refreshed live through GraphQL, so it is not limited to the 50-item recommendation rows. The **Refresh Recommendations** button rebuilds `recommendations.json`, which is useful after removing scenes from Stash.

The **Cinematic Search** section searches the full Stash library by title, file name, and comma-separated tags. The first search loads the library through paginated GraphQL requests and caches the result in the browser for faster follow-up searches.

Clicking a scene card opens the built-in Cinematic player overlay. The overlay streams the scene through Stash and also includes an **Open in Stash** link.

The **From Your Top Tags** row prioritizes scenes that match the strongest tags in the generated preference profile. If no weighted tag profile is available, the dashboard falls back to frequently appearing tags in the loaded recommendation rows.

The recommendation rows intentionally show curated slices, while **Random Picks** fetches six random scenes from the full Stash library. The **Refresh Picks** button pulls a new random set without rebuilding `recommendations.json`.

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

- `agent_library.db`  
  SQLite index for the MCP agent (scenes, tags, performers, studios). Built via **Scan full library** in the MCP UI or `stash_rebuild_agent_index`.

- `agent_index_report.json`  
  Optional metadata written after an agent index rebuild.

- `install_state.json`  
  On-disk record that MCP/dashboard setup already finished (survives **Reload Plugins**; not tied to browser storage).

- `setup_log_snapshot.json`  
  Last lines of `setup_log.txt` for the MCP UI log panel (updated while tasks run).

- `mcp_paths.json` / `agent_ui_snapshot.json`  
  Runtime hints for MCP config paths and UI status when `runPluginOperation` is blocked by another task. **Not committed to git** — no API keys are written to `mcp_paths.json` (keys are injected in the browser from Stash Settings).

These files are generated locally and are not sent to any external service.

## Paths and portability (Linux / macOS / Windows)

Nothing in this plugin assumes a specific Unix user (e.g. `/home/jara/`). Paths come from **your Stash configuration** and the OS user that runs the Stash process.

| What | How the plugin finds it |
|------|-------------------------|
| **Stash database** (`stash-go.sqlite`) | 1) `STASH_SQLITE_PATH` / `STASH_DATABASE_PATH` env · 2) **Settings → System → Database path** (GraphQL `databasePath`) · 3) `database:` in `config.yml` · 4) `$HOME/.stash/stash-go.sqlite` (via `Path.home()`) |
| **Stash config dir** | `server_connection.Dir` in the plugin payload · plugin/config paths from GraphQL · parent of **Settings → System → Plugin path** |
| **Plugin directory** | Directory containing `smart_dashboard.py` (where `agent_library.db`, `setup_log.txt`, `vendor/`, `install_state.json`, etc. are written) |
| **MCP server script** | Absolute path from the MCP UI (`mcp_paths.json` on disk); in external clients use **Settings → System → Plugin path** + `/smart-dashboard/stash_mcp_server.py` (often `community/` or `local/`) |

Override examples (optional):

```bash
export STASH_SQLITE_PATH="/var/lib/stash/stash-go.sqlite"
export STASH_AGENT_INDEX_DB="/opt/stash-plugins/smart-dashboard/agent_library.db"
```

On Windows, use `%USERPROFILE%\.stash\…` instead of `$HOME/.stash/…`.

## Agent integration (optional)

The agent layer runs **locally** on the same machine as Stash. It is separate from the Stash plugin subprocess: you start the MCP server from your AI client, or use the in-Stash **MCP-Server** UI.

### MCP (Model Context Protocol)

Connect AI assistants (Cursor, Claude Desktop, OpenClaw, Windsurf, Cline, …) to search and edit your Stash library.

#### In-Stash MCP Agent UI

1. Click **MCP-Server** in the Stash navigation bar (or open `http://localhost:9999/?smart_dashboard=mcp`).
2. **No terminal required:** on first install, a background task installs MCP dependencies into `vendor/`. After that, **Reload Plugins** does not reinstall if `vendor/` and `agent_library.db` are already present.
3. The MCP UI can start a **library scan** automatically (or use **Scan full library**) to build `agent_library.db` when the index is missing.
4. Use the built-in **chat** for quick queries against the local index (stats, tags, titles, scene IDs).
5. Use **MCP-Config kopieren** / **Copy MCP config** — the JSON is built automatically from **your** Stash instance (plugin path, GraphQL URL from the browser, API key from **Settings → Security**). Nothing is hardcoded for a specific user or server.

The in-Stash chat uses the local index only (no external LLM). For full AI conversations, connect an external agent below.

#### Prerequisites

| Step | Action |
|------|--------|
| 1 | Stash running (default GraphQL: `http://localhost:9999/graphql`) |
| 2 | Plugin installed and reloaded |
| 3 | Wait for the automatic **Install MCP agent dependencies** Stash task (or run it from **Settings → Plugins → Tasks**) |
| 4 | Wait for **Build agent library index** (automatic in the MCP UI, or run the task / MCP tool `stash_rebuild_agent_index`) |

End users do **not** need to run `pip` manually. Admins can check **Settings → Logs** if a plugin task fails.

#### Repository files (MCP)

| File | Purpose |
|------|---------|
| `stash_mcp_server.py` | MCP server (stdio) for AI clients |
| `stash_agent/` | GraphQL client, index builder, chat logic |
| `requirements-agent.txt` | Python deps (`requests`, `mcp`) |
| `mcp-config.example.json` | Generic MCP config template |
| `mcp-config.cursor.json` | Template for Cursor |
| `mcp-config.claude-desktop.json` | Template for Claude Desktop |
| `mcp-config.openclaw.json` | Template for OpenClaw |
| `mcp_paths.json.example` | Example shape of runtime `mcp_paths.json` (generated on your server) |

#### Universal MCP configuration

**Recommended:** copy the live config from **MCP-Server → Copy MCP config** (always correct for that Stash install).

Manual templates (`mcp-config.*.json`) use placeholders only — replace all three before use:

| Placeholder | Source |
|-------------|--------|
| `REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR` | **Settings → System → Plugin path** + `/community/smart-dashboard/` or `/local/smart-dashboard/` |
| `REPLACE_WITH_STASH_GRAPHQL_URL` | Your Stash URL + `/graphql` (e.g. `http://192.168.1.10:9999/graphql`) |
| `REPLACE_WITH_STASH_API_KEY` | **Settings → Security** (leave empty if you do not use an API key) |

```json
{
  "mcpServers": {
    "stash": {
      "command": "python",
      "args": [
        "REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR/stash_mcp_server.py"
      ],
      "env": {
        "STASH_GRAPHQL_URL": "REPLACE_WITH_STASH_GRAPHQL_URL",
        "STASH_API_KEY": "REPLACE_WITH_STASH_API_KEY"
      }
    }
  }
}
```

#### Connect Cursor

1. Open **Cursor** → **Settings** → **MCP** (or edit MCP config JSON).
2. Add the `stash` server block from [Universal MCP configuration](#universal-mcp-configuration), or copy `mcp-config.cursor.json`.
3. Config file locations:
   - Project: `.cursor/mcp.json`
   - Windows: `%USERPROFILE%\.cursor\mcp.json`
   - macOS/Linux: `~/.cursor/mcp.json`
4. Restart Cursor or reload MCP servers.
5. In chat, tools appear as `stash_*` (e.g. `stash_agent_chat`, `stash_search_scenes`).

**Suggested first prompts:**

- *Call `stash_rebuild_agent_index` if the index may be outdated.*
- *Use `stash_agent_library_overview` for library stats.*
- *Search with `stash_agent_chat` for scenes matching …*

#### Connect Claude Desktop

1. Edit the Claude Desktop config:
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`
2. Add the `stash` entry under `mcpServers` (see `mcp-config.claude-desktop.json`).
3. Fully quit and restart Claude Desktop.
4. In a new chat, open the tools menu — **stash** tools should be listed.

#### Connect OpenClaw

OpenClaw uses the same **stdio** MCP pattern:

1. Open your OpenClaw MCP / gateway configuration.
2. Add server **stash** with:
   - **Command:** `python` (or absolute path to Stash’s Python)
   - **Args:** absolute path to `stash_mcp_server.py`
   - **Env:** `STASH_GRAPHQL_URL`, optional `STASH_API_KEY`
3. Restart the gateway and ask the agent to use Stash tools.

See `mcp-config.openclaw.json` for a JSON starting point (field names may vary by OpenClaw version).

#### Other MCP clients

For Windsurf, Cline, Zed, or any MCP-capable client:

1. Add a **stdio** / **local command** MCP server.
2. Use the [universal configuration](#universal-mcp-configuration) above.
3. Reload the client and verify `stash_*` tools appear.

#### MCP tools reference

See also the [full MCP command table](#mcp-tools-the-ai-can-run-command-reference) in **Quick start** (what the AI can run and what it can do for users).

| Tool | Purpose |
|------|---------|
| `stash_rebuild_agent_index` | Full library scan → `agent_library.db` |
| `stash_agent_library_overview` | Index stats and samples |
| `stash_agent_chat` | Natural-language query against the local index |
| `stash_agent_search_index` | Direct index search |
| `stash_search_scenes` | Live GraphQL scene search |
| `stash_get_scene` | Single scene (live GraphQL) |
| `stash_update_scene` | Edit scene (tags, performers, studio, rating, …) |
| `stash_search_tags` / `stash_search_performers` / `stash_search_studios` | Entity search |
| `stash_get_library_stats` | Scene count / base URL |
| `stash_list_duplicate_groups` | Read `duplicates_report.json` (after duplicate scan) |

**Recommended agent workflow:**

1. After large library changes → `stash_rebuild_agent_index`
2. Search / Q&A → `stash_agent_chat` or `stash_agent_search_index`
3. Edits → `stash_get_scene` then `stash_update_scene`  
   Use `tag_mode` / `performer_mode` **`add`** to extend metadata. With **`set`**, send the **full** tag/performer ID lists (Stash replaces lists on `set`).

#### Plugin tasks (MCP-related)

These modes are passed to `smart_dashboard.py` from the UI or Stash plugin runner:

| Task | Purpose |
|------|---------|
| `setup_agent` | Install `requirements-agent.txt` |
| `build_agent_index` | Rebuild `agent_library.db` |
| `agent_query` | Synchronous chat reply (used by MCP UI) |
| `agent_index_stats` | Read index statistics |

#### MCP environment variables

| Variable | Purpose |
|----------|---------|
| `STASH_GRAPHQL_URL` | GraphQL endpoint (default `http://localhost:9999/graphql`) |
| `STASH_API_KEY` | Optional Stash API key |
| `STASH_SQLITE_PATH` / `STASH_DATABASE_PATH` | Optional override for Stash’s `stash-go.sqlite` (see **Settings → System → Database path**) |
| `STASH_AGENT_INDEX_DB` | Override path to `agent_library.db` |
| `STASH_AGENT_INDEX_REPORT` | Override path to `agent_index_report.json` |

#### MCP troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing dependency 'mcp'` | `pip install -r requirements-agent.txt` |
| MCP server won’t start | Use **absolute** path to `stash_mcp_server.py`; same Python as Stash |
| No tools in AI client | Restart client; validate JSON; check MCP server logs |
| MCP UI log empty / stuck on “waiting” | Open MCP page and click **Refresh log**; confirm `setup_log_snapshot.json` exists in the plugin folder |
| Stash log shows “Error” for MCP lines | Normal: plugin diagnostics use stderr; success messages appear there too |
| GraphQL errors | Stash running? Correct `STASH_GRAPHQL_URL`? API key? |
| Empty agent answers | Run index build: UI scan or `stash_rebuild_agent_index` |
| Tags cleared on update | Use `tag_mode: "add"`; with `set`, include all IDs |

**Privacy:** MCP server and `agent_library.db` stay on your machine. Your AI provider’s privacy policy applies to anything you send in chat.

#### MCP checklist

- [ ] Stash running  
- [ ] `requirements-agent.txt` installed  
- [ ] `agent_library.db` built  
- [ ] MCP config uses absolute path to `stash_mcp_server.py`  
- [ ] `STASH_GRAPHQL_URL` correct  
- [ ] AI client restarted  
- [ ] `stash_*` tools visible  

> **Deutsch:** Kurzfassung der Verbindungsanleitung auch in [MCP_AGENT_CONNECT.md](MCP_AGENT_CONNECT.md) (verweist auf diesen Abschnitt).

### HTTP API (REST-style)

For scripts or agents **without** MCP:

```bash
pip install -r requirements-agent.txt
python stash_http_server.py
```

Default: `http://127.0.0.1:8765`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/v1/library/stats` | Scene count |
| GET | `/v1/scenes?q=...&tag=...&performer=...&studio=...` | Search scenes |
| GET | `/v1/scenes/{id}` | Scene details |
| POST | `/v1/scenes/{id}/update` | JSON body: `tag_names`, `performer_names`, `studio_name`, `rating100`, … |
| GET | `/v1/tags`, `/v1/performers`, `/v1/studios` | Search entities |
| GET | `/v1/duplicates` | Read `duplicates_report.json` |

Optional auth: set `STASH_AGENT_HTTP_TOKEN` and send `Authorization: Bearer <token>`.

HTTP-only environment variables: `STASH_AGENT_HTTP_HOST`, `STASH_AGENT_HTTP_PORT`, `STASH_AGENT_HTTP_TOKEN` (plus `STASH_GRAPHQL_URL`, `STASH_API_KEY`).

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
