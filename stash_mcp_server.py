#!/usr/bin/env python3
"""MCP server (stdio) exposing full Stash library access for AI agents.

Configure in Cursor / OpenClaw / Claude Desktop, e.g.:

  {
    "mcpServers": {
      "stash": {
        "command": "python",
        "args": ["REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR/stash_mcp_server.py"],
        "env": {
          "STASH_GRAPHQL_URL": "REPLACE_WITH_STASH_GRAPHQL_URL",
          "STASH_API_KEY": "REPLACE_WITH_STASH_API_KEY"
        }
      }
    }
  }

Install agent deps once:
  python -m pip install -r requirements-agent.txt
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, List, Optional

_PLUGIN_DIR = Path(__file__).resolve().parent
_VENDOR_DIR = _PLUGIN_DIR / "vendor"
if _VENDOR_DIR.is_dir():
    vendor = str(_VENDOR_DIR.resolve())
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    print(
        "Missing dependency 'mcp'. Install with:\n"
        "  python -m pip install -r requirements-agent.txt",
        file=sys.stderr,
    )
    raise

from stash_agent.service import StashAgentService

mcp = FastMCP(
    "stash",
    instructions=(
        "Stash media library agent with a local cinematic index (agent_library.db). "
        "Call stash_rebuild_agent_index after library changes. Use stash_agent_chat for "
        "natural-language queries against the local index, or stash_agent_search_index for direct search. "
        "Use stash_search_scenes / stash_get_scene / stash_update_scene for live GraphQL edits. "
        "Prefer tag_mode/performer_mode 'add' when extending metadata."
    ),
)

_service: Optional[StashAgentService] = None


def service() -> StashAgentService:
    global _service
    if _service is None:
        _service = StashAgentService.from_config()
    return _service


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


@mcp.tool()
def stash_get_library_stats() -> str:
    """Return total scene count and Stash base URL."""
    return _json(service().get_library_stats())


@mcp.tool()
def stash_search_scenes(
    query: str = "",
    tag_names: Optional[List[str]] = None,
    performer_names: Optional[List[str]] = None,
    studio_name: str = "",
    page: int = 1,
    per_page: int = 40,
    sort: str = "date",
    direction: str = "DESC",
) -> str:
    """Search scenes by title/filename (query) and optional tag/performer/studio filters."""
    return _json(
        service().search_scenes(
            query=query or None,
            tag_names=tag_names,
            performer_names=performer_names,
            studio_name=studio_name or None,
            page=page,
            per_page=per_page,
            sort=sort,
            direction=direction,
        )
    )


@mcp.tool()
def stash_get_scene(scene_id: str) -> str:
    """Load one scene by ID with tags, performers, studio, paths, and Stash URLs."""
    return _json(service().get_scene(scene_id))


@mcp.tool()
def stash_update_scene(
    scene_id: str,
    title: str = "",
    details: str = "",
    date: str = "",
    rating100: int = -1,
    organized: Optional[bool] = None,
    studio_id: str = "",
    studio_name: str = "",
    clear_studio: bool = False,
    tag_ids: Optional[List[str]] = None,
    tag_names: Optional[List[str]] = None,
    tag_mode: str = "add",
    performer_ids: Optional[List[str]] = None,
    performer_names: Optional[List[str]] = None,
    performer_mode: str = "add",
) -> str:
    """Update scene metadata. Use tag_mode/performer_mode: add, set, or remove. Creates missing tags/performers/studio when using names."""
    kwargs: dict[str, Any] = {"scene_id": scene_id}
    if title:
        kwargs["title"] = title
    if details:
        kwargs["details"] = details
    if date:
        kwargs["date"] = date
    if rating100 >= 0:
        kwargs["rating100"] = rating100
    if organized is not None:
        kwargs["organized"] = organized
    if studio_id:
        kwargs["studio_id"] = studio_id
    if studio_name:
        kwargs["studio_name"] = studio_name
    if clear_studio:
        kwargs["clear_studio"] = True
    if tag_ids is not None:
        kwargs["tag_ids"] = tag_ids
        if tag_mode in ("add", "set", "remove"):
            kwargs["tag_mode"] = tag_mode
    elif tag_names:
        kwargs["tag_names"] = tag_names
        kwargs["tag_mode"] = tag_mode if tag_mode in ("add", "set", "remove") else "add"
    if performer_ids is not None:
        kwargs["performer_ids"] = performer_ids
        if performer_mode in ("add", "set", "remove"):
            kwargs["performer_mode"] = performer_mode
    elif performer_names:
        kwargs["performer_names"] = performer_names
        kwargs["performer_mode"] = performer_mode if performer_mode in ("add", "set", "remove") else "add"

    return _json(service().update_scene(**kwargs))


@mcp.tool()
def stash_search_tags(query: str = "", page: int = 1, per_page: int = 40) -> str:
    """Search tags by name."""
    return _json(service().search_tags(query=query, page=page, per_page=per_page))


@mcp.tool()
def stash_search_performers(query: str = "", page: int = 1, per_page: int = 40) -> str:
    """Search performers by name."""
    return _json(service().search_performers(query=query, page=page, per_page=per_page))


@mcp.tool()
def stash_search_studios(query: str = "", page: int = 1, per_page: int = 40) -> str:
    """Search studios by name."""
    return _json(service().search_studios(query=query, page=page, per_page=per_page))


@mcp.tool()
def stash_list_duplicate_groups(limit: int = 20) -> str:
    """Read visual duplicate groups from duplicates_report.json (requires smart_dup_scan)."""
    return _json(service().list_duplicate_groups(limit=limit))


@mcp.tool()
def stash_rebuild_agent_index() -> str:
    """Scan the full Stash library and rebuild the local agent index database (agent_library.db)."""
    return _json(service().build_agent_index())


@mcp.tool()
def stash_agent_library_overview() -> str:
    """Return stats and samples from the local agent index (scene/tag/performer/studio counts)."""
    return _json(service().get_agent_index_stats())


@mcp.tool()
def stash_agent_search_index(query: str = "", limit: int = 12) -> str:
    """Fast search on the local agent index (title, path, tags, performers, studio, details)."""
    store = service().index_store()
    return _json({"query": query, "count": len(store.search(query, limit=limit)), "scenes": store.search(query, limit=limit)})


@mcp.tool()
def stash_agent_chat(message: str, limit: int = 12) -> str:
    """Chat with the local Stash agent (searches agent_library.db). Rebuild the index if results are stale."""
    return _json(service().agent_chat(message, limit=limit))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
