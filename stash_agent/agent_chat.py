from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from stash_agent.index_store import AgentIndexStore


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _extract_scene_id(message: str) -> Optional[str]:
    match = re.search(r"(?:scene|szene)\s*#?(\d+)", message, flags=re.IGNORECASE)
    if match:
        return match.group(1)
    if message.strip().isdigit():
        return message.strip()
    return None


def _wants_stats(message: str) -> bool:
    normalized = _normalize(message)
    keywords = (
        "how many",
        "wie viele",
        "wie viel",
        "library stats",
        "statistik",
        "statistics",
        "overview",
        "übersicht",
        "übersicht",
        "index status",
        "datenbank",
        "database",
    )
    return any(keyword in normalized for keyword in keywords)


def _wants_help(message: str) -> bool:
    normalized = _normalize(message)
    return normalized in {"help", "hilfe", "?"} or normalized.startswith("help ") or normalized.startswith("hilfe ")


def _search_terms(message: str) -> str:
    cleaned = message.strip()
    cleaned = re.sub(r"^(search|suche|find|finde)\s+", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^tags?\s*:\s*", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def agent_chat(
    store: AgentIndexStore,
    message: str,
    *,
    language: Optional[str] = None,
    limit: int = 12,
) -> Dict[str, Any]:
    del language  # reserved for future localized replies
    stats = store.get_stats()
    if not stats.get("ready"):
        return {
            "reply": (
                "The agent library is empty. Run a full library scan first "
                "(Build Agent Index / build_agent_index)."
            ),
            "scenes": [],
            "stats": stats,
            "intent": "index_missing",
        }

    text = message.strip()
    if not text:
        return {
            "reply": "Ask about your library, e.g. search terms, tags, performers, or type 'stats' for an overview.",
            "scenes": [],
            "stats": stats,
            "intent": "empty",
        }

    scene_id = _extract_scene_id(text)
    if scene_id:
        scenes = store.search(scene_id, limit=1)
        scenes = [scene for scene in scenes if str(scene.get("id")) == scene_id]
        if not scenes:
            with store.connect() as connection:
                row = connection.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
                if row:
                    scenes = [store._row_to_scene(row)]
        if scenes:
            return {
                "reply": f"Loaded scene {scene_id} from the local agent index.",
                "scenes": scenes,
                "stats": stats,
                "intent": "scene_by_id",
            }
        return {
            "reply": f"Scene {scene_id} was not found in the local agent index.",
            "scenes": [],
            "stats": stats,
            "intent": "scene_not_found",
        }

    if _wants_help(text):
        return {
            "reply": (
                "Agent commands: 'stats' for library overview; search by title, filename, tag, performer, "
                "or studio; 'scene 123' for a specific scene. External MCP clients can use "
                "stash_agent_chat and stash_rebuild_agent_index."
            ),
            "scenes": store.search("", limit=6),
            "stats": stats,
            "intent": "help",
        }

    if _wants_stats(text):
        top_tags = store.top_tags(8)
        tag_line = ", ".join(f"{item['name']} ({item['scene_count']})" for item in top_tags[:6]) or "n/a"
        return {
            "reply": (
                f"Local agent index: {stats['scene_count']} scenes, {stats['tag_count']} tags, "
                f"{stats['performer_count']} performers, {stats['studio_count']} studios. "
                f"Top tags: {tag_line}."
            ),
            "scenes": store.search("", limit=6),
            "stats": stats,
            "intent": "stats",
            "top_tags": top_tags,
        }

    query = _search_terms(text)
    scenes = store.search(query, limit=limit)
    if scenes:
        return {
            "reply": f'Found {len(scenes)} scene(s) in the local index for "{query}".',
            "scenes": scenes,
            "stats": stats,
            "intent": "search",
            "query": query,
        }

    return {
        "reply": f'No scenes matched "{query}" in the local agent index. Try broader terms or rebuild the index.',
        "scenes": [],
        "stats": stats,
        "intent": "search_empty",
        "query": query,
    }
