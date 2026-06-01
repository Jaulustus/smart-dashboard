from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

ProgressCallback = Optional[Callable[[str], None]]

from stash_agent.client import StashAgentClient, StashAgentError
from stash_agent.config import AgentConfig
from stash_agent.index_store import AgentIndexStore, _utc_now_iso

FIND_SCENES_INDEX_QUERY = """
query StashAgentIndexScenes($filter: FindFilterType!) {
  findScenes(filter: $filter) {
    count
    scenes {
      id
      title
      details
      rating100
      play_count
      last_played_at
      paths { screenshot stream }
      files { path }
      tags { id name }
      performers { id name }
      studio { id name }
    }
  }
}
"""

FIND_TAGS_INDEX_QUERY = """
query StashAgentIndexTags($filter: FindFilterType!) {
  findTags(filter: $filter) {
    count
    tags { id name }
  }
}
"""

FIND_PERFORMERS_INDEX_QUERY = """
query StashAgentIndexPerformers($filter: FindFilterType!) {
  findPerformers(filter: $filter) {
    count
    performers { id name }
  }
}
"""

FIND_STUDIOS_INDEX_QUERY = """
query StashAgentIndexStudios($filter: FindFilterType!) {
  findStudios(filter: $filter) {
    count
    studios { id name }
  }
}
"""


def _entity_names(items: Any) -> List[str]:
    if not isinstance(items, list):
        return []
    names: List[str] = []
    for item in items:
        if isinstance(item, dict) and item.get("name"):
            names.append(str(item["name"]))
    return names


def _entity_rows(items: Any) -> List[Dict[str, str]]:
    if not isinstance(items, list):
        return []
    rows: List[Dict[str, str]] = []
    for item in items:
        if isinstance(item, dict) and item.get("id") is not None and item.get("name"):
            rows.append({"id": str(item["id"]), "name": str(item["name"])})
    return rows


def _first_file_path(scene: Dict[str, Any]) -> Optional[str]:
    files = scene.get("files")
    if isinstance(files, list) and files:
        path = files[0].get("path") if isinstance(files[0], dict) else None
        return str(path) if path else None
    return None


def _paginate_entities(
    client: StashAgentClient,
    query: str,
    container_key: str,
    list_key: str,
    per_page: int = 500,
    on_progress: ProgressCallback = None,
    progress_label: str = "",
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    page = 1
    while True:
        data = client.execute(query, {"filter": {"page": page, "per_page": per_page}})
        container = data.get(container_key) or {}
        page_items = container.get(list_key) or []
        if not isinstance(page_items, list):
            break
        items.extend(item for item in page_items if isinstance(item, dict))
        count = container.get("count")
        if on_progress and progress_label and (page == 1 or page % 5 == 0 or not page_items):
            total = int(count) if isinstance(count, int) else None
            if total:
                _report_progress(
                    on_progress,
                    f"GraphQL {progress_label}: {len(items)} / {total} geladen …",
                )
            else:
                _report_progress(on_progress, f"GraphQL {progress_label}: {len(items)} geladen …")
        if not page_items or (isinstance(count, int) and len(items) >= count) or len(page_items) < per_page:
            break
        page += 1
    return items


def _log_index_fallback(message: str) -> None:
    print(f"[Smart Dashboard Agent] {message}", file=sys.stderr, flush=True)


def _report_progress(on_progress: ProgressCallback, message: str) -> None:
    text = str(message or "").strip()
    if not text:
        return
    _log_index_fallback(text)
    if on_progress:
        on_progress(text)


def build_agent_index(
    client: StashAgentClient,
    store: AgentIndexStore,
    config: AgentConfig,
    report_path: Optional[Any] = None,
    stash_sqlite_hints: Optional[Sequence[Path]] = None,
    on_progress: ProgressCallback = None,
) -> Dict[str, Any]:
    from stash_agent.stash_db_source import (
        StashSqliteError,
        build_agent_index_from_stash_sqlite,
        resolve_stash_sqlite_path,
    )

    base = config.stash_base_url.rstrip("/")
    try:
        store.begin_build(stash_base_url=base, index_source="pending")
        _report_progress(on_progress, f"agent_library.db angelegt: {store.db_path}")
    except OSError as exc:
        raise StashAgentError(f"Cannot create agent_library.db: {exc}") from exc

    sqlite_path = resolve_stash_sqlite_path(stash_sqlite_hints)
    if sqlite_path:
        _report_progress(on_progress, f"Stash-Datenbank gefunden: {sqlite_path}")
        try:
            return build_agent_index_from_stash_sqlite(
                sqlite_path,
                store,
                config,
                report_path=report_path,
                on_progress=on_progress,
            )
        except StashSqliteError as exc:
            _report_progress(on_progress, f"Stash-SQLite-Index fehlgeschlagen, nutze GraphQL: {exc}")
        except Exception as exc:
            _report_progress(on_progress, f"Stash-SQLite-Index Fehler, nutze GraphQL: {exc}")
    else:
        _report_progress(
            on_progress,
            "stash-go.sqlite nicht gefunden — Index wird per GraphQL aufgebaut (langsamer).",
        )

    base = config.stash_base_url.rstrip("/")
    _report_progress(on_progress, "Lade Metadaten per GraphQL von Stash …")
    scenes = _paginate_entities(
        client, FIND_SCENES_INDEX_QUERY, "findScenes", "scenes", on_progress=on_progress, progress_label="Szenen"
    )
    _report_progress(on_progress, f"GraphQL: {len(scenes)} Szenen geladen.")
    tags = _paginate_entities(
        client, FIND_TAGS_INDEX_QUERY, "findTags", "tags", on_progress=on_progress, progress_label="Tags"
    )
    _report_progress(on_progress, f"GraphQL: {len(tags)} Tags geladen.")
    performers = _paginate_entities(
        client,
        FIND_PERFORMERS_INDEX_QUERY,
        "findPerformers",
        "performers",
        on_progress=on_progress,
        progress_label="Performer",
    )
    _report_progress(on_progress, f"GraphQL: {len(performers)} Performer geladen.")
    studios = _paginate_entities(
        client, FIND_STUDIOS_INDEX_QUERY, "findStudios", "studios", on_progress=on_progress, progress_label="Studios"
    )
    _report_progress(on_progress, f"GraphQL: {len(studios)} Studios geladen.")
    _report_progress(on_progress, f"Schreibe agent_library.db ({store.db_path}) …")

    with store.connect() as connection:
        store.initialize_schema(connection)
        store.clear(connection)
        store.set_meta(connection, "generated_at", _utc_now_iso())
        store.set_meta(connection, "stash_base_url", base)
        store.set_meta(connection, "index_source", "graphql")
        store.set_meta(connection, "graphql_query_variant", "agent_index_v1")

        written = 0
        for scene in scenes:
            scene_id = str(scene.get("id", ""))
            if not scene_id:
                continue
            tag_names = _entity_names(scene.get("tags"))
            performer_names = _entity_names(scene.get("performers"))
            studio = scene.get("studio") if isinstance(scene.get("studio"), dict) else {}
            studio_name = studio.get("name") if studio else None
            paths = scene.get("paths") if isinstance(scene.get("paths"), dict) else {}
            store.insert_scene(
                connection,
                {
                    "id": scene_id,
                    "title": scene.get("title"),
                    "file_path": _first_file_path(scene),
                    "rating100": scene.get("rating100"),
                    "play_count": scene.get("play_count") or 0,
                    "studio_name": studio_name,
                    "last_played_at": scene.get("last_played_at"),
                    "tags_text": ", ".join(tag_names),
                    "performers_text": ", ".join(performer_names),
                    "details": (scene.get("details") or "")[:2000],
                    "stash_url": f"{base}/scenes/{scene_id}",
                    "stream_url": paths.get("stream") or f"{base}/scene/{scene_id}/stream",
                    "thumbnail": paths.get("screenshot"),
                },
            )
            written += 1
            if written % 5000 == 0:
                _report_progress(on_progress, f"… {written} / {len(scenes)} Szenen in agent_library.db geschrieben")

        store.insert_entity_rows(connection, "tags", _entity_rows(tags))
        store.insert_entity_rows(connection, "performers", _entity_rows(performers))
        store.insert_entity_rows(connection, "studios", _entity_rows(studios))
        connection.commit()

    stats = store.get_stats()
    _report_progress(
        on_progress,
        f"GraphQL-Index fertig: {stats['scene_count']} Szenen, {stats['tag_count']} Tags, "
        f"{stats['performer_count']} Performer, {stats['studio_count']} Studios.",
    )
    result = {
        "message": (
            f"Agent library index built via GraphQL: {stats['scene_count']} scenes, "
            f"{stats['tag_count']} tags, {stats['performer_count']} performers, "
            f"{stats['studio_count']} studios."
        ),
        "index": stats,
        "db_path": str(store.db_path),
        "index_source": "graphql",
    }
    if report_path is not None:
        store.write_build_report(report_path, result)
    return result


def rebuild_agent_index_from_config() -> Dict[str, Any]:
    from stash_agent.service import StashAgentService

    service = StashAgentService.from_config()
    store = AgentIndexStore(service.config.agent_index_db)
    return build_agent_index(
        service.client,
        store,
        service.config,
        report_path=service.config.agent_index_report,
    )
