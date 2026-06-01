# Smart Dashboard & Advanced Duplicate Finder

A local Stashapp plugin for advanced visual duplicate detection and dashboard recommendation generation.

**Author:** Jaulustus  
**Repository:** https://github.com/Jaulustus/smart-dashboard

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

These files are generated locally and are not sent to any external service.

## Agent integration (optional)

The agent layer runs **locally** on the same machine as Stash. It is separate from the Stash plugin subprocess: you start the MCP server from your AI client, or use the in-Stash **MCP-Server** UI.

### MCP (Model Context Protocol)

Connect AI assistants (Cursor, Claude Desktop, OpenClaw, Windsurf, Cline, …) to search and edit your Stash library.

#### In-Stash MCP Agent UI

1. Click **MCP-Server** in the Stash navigation bar (or open `http://localhost:9999/?smart_dashboard=mcp`).
2. On first open, **MCP dependencies** are installed (`requirements-agent.txt`).
3. Click **Scan full library** to build `agent_library.db`.
4. Use the built-in **chat** for quick queries against the local index (stats, tags, titles, scene IDs).
5. Use **Connect your AI agent** in the sidebar to copy an MCP JSON config.

The in-Stash chat uses the local index only (no external LLM). For full AI conversations, connect an external agent below.

#### Prerequisites

| Step | Action |
|------|--------|
| 1 | Stash running (default GraphQL: `http://localhost:9999/graphql`) |
| 2 | Plugin installed and reloaded |
| 3 | `pip install -r requirements-agent.txt` (or use **Install MCP dependencies** in the UI) |
| 4 | Build `agent_library.db` (scan in UI or MCP tool `stash_rebuild_agent_index`) |

Use the **same Python** Stash uses for plugins (see Stash settings / plugin task logs).

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

#### Universal MCP configuration

Replace `REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR` with your plugin folder path.

```json
{
  "mcpServers": {
    "stash": {
      "command": "python",
      "args": [
        "REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR/stash_mcp_server.py"
      ],
      "env": {
        "STASH_GRAPHQL_URL": "http://localhost:9999/graphql",
        "STASH_API_KEY": ""
      }
    }
  }
}
```

If Stash uses an API key (*Settings → Security*), set `STASH_API_KEY`. Otherwise leave it empty.

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
| `STASH_AGENT_INDEX_DB` | Override path to `agent_library.db` |
| `STASH_AGENT_INDEX_REPORT` | Override path to `agent_index_report.json` |

#### MCP troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing dependency 'mcp'` | `pip install -r requirements-agent.txt` |
| MCP server won’t start | Use **absolute** path to `stash_mcp_server.py`; same Python as Stash |
| No tools in AI client | Restart client; validate JSON; check MCP server logs |
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
