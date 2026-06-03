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

On first run, missing packages are installed into vendor/ next to this file (no
requirements-agent.txt needed for Cursor / OpenClaw). Set STASH_MCP_SKIP_AUTO_INSTALL=1
to disable. The Stash plugin task still uses requirements-agent.txt when present.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

# Same pins as requirements-agent.txt (kept in sync for Stash plugin pip tasks).
AGENT_REQUIREMENTS: Tuple[str, ...] = (
    "requests>=2.28.0",
    "mcp>=1.2.0",
)

_PLUGIN_DIR = Path(__file__).resolve().parent
_VENDOR_DIR = _PLUGIN_DIR / "vendor"


def _vendor_on_path() -> None:
    if _VENDOR_DIR.is_dir():
        vendor = str(_VENDOR_DIR.resolve())
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
    if str(_PLUGIN_DIR) not in sys.path:
        sys.path.insert(0, str(_PLUGIN_DIR))


def _agent_imports_ready() -> bool:
    try:
        import requests  # noqa: F401
        from mcp.server.fastmcp import FastMCP  # noqa: F401

        return True
    except ImportError:
        return False


def _pip_install_agent_requirements() -> None:
    _VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        *AGENT_REQUIREMENTS,
        "-t",
        str(_VENDOR_DIR),
        "--no-warn-script-location",
    ]
    print(
        "[stash-mcp] Installing agent dependencies into vendor/ …",
        file=sys.stderr,
        flush=True,
    )
    result = subprocess.run(
        command,
        cwd=str(_PLUGIN_DIR),
        capture_output=True,
        text=True,
    )
    if result.stdout:
        print(result.stdout, file=sys.stderr, end="")
    if result.returncode != 0:
        hint = " ".join(AGENT_REQUIREMENTS)
        stderr = (result.stderr or "").strip()
        raise RuntimeError(
            f"pip install failed (exit {result.returncode}). "
            f"Try: {sys.executable} -m pip install {hint}\n{stderr}"
        )


def ensure_agent_dependencies() -> None:
    _vendor_on_path()
    if _agent_imports_ready():
        return
    if os.environ.get("STASH_MCP_SKIP_AUTO_INSTALL", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        raise ImportError(
            "Missing MCP agent dependencies. Install with:\n"
            f"  {sys.executable} -m pip install {' '.join(AGENT_REQUIREMENTS)}"
        )
    _pip_install_agent_requirements()
    _vendor_on_path()
    if not _agent_imports_ready():
        raise ImportError(
            "Dependencies still missing after pip install into vendor/. "
            f"Packages: {', '.join(AGENT_REQUIREMENTS)}"
        )


ensure_agent_dependencies()

from mcp.server.fastmcp import FastMCP  # noqa: E402

from stash_agent.service import StashAgentService

# MCP tools are registered here (stdio protocol), NOT stored inside agent_library.db.
MCP_TOOL_CATALOG: Tuple[Dict[str, Any], ...] = (
    {
        "name": "stash_list_mcp_tools",
        "summary": "List every Stash MCP tool and explain agent_library.db (call this first if confused).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_get_library_stats",
        "summary": "Live scene count and Stash base URL (GraphQL).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_agent_library_overview",
        "summary": "Index stats/samples from agent_library.db (scenes/tags — not commands).",
        "uses_agent_library_db": True,
    },
    {
        "name": "stash_rebuild_agent_index",
        "summary": "Rebuild agent_library.db from Stash (full library scan).",
        "uses_agent_library_db": True,
    },
    {
        "name": "stash_agent_search_index",
        "summary": "Fast text search in agent_library.db.",
        "uses_agent_library_db": True,
    },
    {
        "name": "stash_agent_chat",
        "summary": "Natural-language Q&A using agent_library.db.",
        "uses_agent_library_db": True,
    },
    {
        "name": "stash_search_scenes",
        "summary": "Search scenes via live Stash GraphQL.",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_get_scene",
        "summary": "Load one scene by ID (GraphQL).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_update_scene",
        "summary": "Edit scene metadata (GraphQL).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_search_tags",
        "summary": "Search tags (GraphQL).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_search_performers",
        "summary": "Search performers (GraphQL).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_search_studios",
        "summary": "Search studios (GraphQL).",
        "uses_agent_library_db": False,
    },
    {
        "name": "stash_list_duplicate_groups",
        "summary": "Read duplicate report JSON (after Cinematic duplicate scan).",
        "uses_agent_library_db": False,
    },
)

MCP_SERVER_INSTRUCTIONS = (
    "You are connected to the Stash MCP server (tools prefixed stash_). "
    "IMPORTANT: agent_library.db is ONLY a local search index of scenes/tags/performers — "
    "it does NOT contain MCP commands or shell commands. "
    "To see available actions, call stash_list_mcp_tools (or use your client's MCP tool list). "
    "If the index is empty/missing, call stash_rebuild_agent_index or copy agent_library.db "
    "from the Stash server. "
    "For live edits use stash_search_scenes / stash_get_scene / stash_update_scene (GraphQL). "
    "For fast local search use stash_agent_search_index or stash_agent_chat. "
    "Prefer tag_mode/performer_mode 'add' when extending metadata."
)

mcp = FastMCP(
    "stash",
    instructions=MCP_SERVER_INSTRUCTIONS,
)

_service: Optional[StashAgentService] = None


def service() -> StashAgentService:
    global _service
    if _service is None:
        _service = StashAgentService.from_config()
    return _service


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def _agent_index_context() -> Dict[str, Any]:
    stats = service().get_agent_index_stats()
    ready = bool(stats.get("ready") and int(stats.get("scene_count") or 0) > 0)
    return {
        "agent_library_db_path": str(service().config.agent_index_db),
        "index_ready": ready,
        "index_stats": stats,
    }


@mcp.tool()
def stash_list_mcp_tools() -> str:
    """List all Stash MCP tools. agent_library.db holds scene metadata only — NOT commands."""
    ctx = _agent_index_context()
    return _json(
        {
            "agent_library_db_is_not_commands": True,
            "explanation": (
                "agent_library.db is a SQLite index (tables: scenes, tags, performers, studios). "
                "MCP commands are separate tools exposed by this server (stash_*). "
                "OpenClaw/Cursor discover them via the MCP protocol, not by reading the database."
            ),
            "if_index_empty": (
                "Call stash_rebuild_agent_index (needs STASH_GRAPHQL_URL), or copy agent_library.db "
                "from the machine where Stash ran the library scan."
            ),
            "recommended_first_calls": [
                "stash_list_mcp_tools",
                "stash_agent_library_overview",
                "stash_get_library_stats",
            ],
            "tools": list(MCP_TOOL_CATALOG),
            **ctx,
        }
    )


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
    ctx = _agent_index_context()
    payload: Dict[str, Any] = {
        "note": (
            "This reports library content in agent_library.db, not available MCP tools. "
            "For commands, call stash_list_mcp_tools."
        ),
        **ctx,
    }
    if not ctx["index_ready"]:
        payload["hint"] = (
            "Index missing or empty on this machine. Run stash_rebuild_agent_index or copy "
            "agent_library.db from your Stash plugin folder."
        )
    return _json(payload)


@mcp.tool()
def stash_agent_search_index(query: str = "", limit: int = 12) -> str:
    """Fast search on the local agent index (title, path, tags, performers, studio, details)."""
    store = service().index_store()
    return _json({"query": query, "count": len(store.search(query, limit=limit)), "scenes": store.search(query, limit=limit)})


@mcp.tool()
def stash_agent_chat(message: str, limit: int = 12) -> str:
    """Chat with the local Stash agent (searches agent_library.db). Rebuild the index if results are stale."""
    result = service().agent_chat(message, limit=limit)
    if not _agent_index_context()["index_ready"]:
        result = {
            **result,
            "warning": "agent_library.db not ready — call stash_rebuild_agent_index or stash_list_mcp_tools.",
        }
    return _json(result)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
