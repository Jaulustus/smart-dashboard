"""Read Stash metadata directly from stash-go.sqlite (faster than GraphQL pagination)."""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple

ProgressCallback = Optional[Callable[[str], None]]

from stash_agent.config import AgentConfig
from stash_agent.index_store import AgentIndexStore, _utc_now_iso


class StashSqliteError(Exception):
    """Raised when the Stash database cannot be read for indexing."""


def _log(message: str) -> None:
    print(f"[Smart Dashboard Agent] {message}", file=sys.stderr, flush=True)


def _report_progress(on_progress: ProgressCallback, message: str) -> None:
    text = str(message or "").strip()
    if not text:
        return
    _log(text)
    if on_progress:
        on_progress(text)


def _config_directories() -> List[Path]:
    dirs: List[Path] = []
    explicit_config = os.environ.get("STASH_CONFIG_PATH") or os.environ.get("STASH_CONFIG")
    if explicit_config:
        path = Path(explicit_config).expanduser()
        dirs.append(path if path.is_dir() else path.parent)
    dirs.append(Path.home() / ".stash")
    return dirs


def _parse_database_from_config(config_path: Path) -> Optional[Path]:
    if not config_path.is_file():
        return None
    try:
        lines = config_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not stripped.lower().startswith("database:"):
            continue
        value = stripped.split(":", 1)[1].strip().strip("'\"")
        if not value:
            return None
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            candidate = (config_path.parent / candidate).resolve()
        return candidate
    return None


def _sqlite_candidates_from_hints(extra_paths: Optional[Sequence[Path]]) -> List[Path]:
    """Turn GraphQL/config hints into concrete stash-go.sqlite paths (order preserved)."""
    if not extra_paths:
        return []

    candidates: List[Path] = []
    seen: set[str] = set()

    def add(candidate: Optional[Path]) -> None:
        if candidate is None:
            return
        resolved = candidate.expanduser()
        if resolved.is_dir():
            resolved = resolved / "stash-go.sqlite"
        if not resolved.is_file():
            return
        key = str(resolved.resolve())
        if key in seen:
            return
        seen.add(key)
        candidates.append(resolved.resolve())

    for raw in extra_paths:
        path = Path(raw).expanduser()
        if path.is_file():
            add(path)
            continue
        if path.is_dir():
            add(path / "stash-go.sqlite")
            from_config = _parse_database_from_config(path / "config.yml")
            if from_config:
                add(from_config)
            continue
        parent = path.parent
        if parent.is_dir():
            add(parent / "stash-go.sqlite")
            from_config = _parse_database_from_config(parent / "config.yml")
            if from_config:
                add(from_config)

    return candidates


def stash_sqlite_paths_from_mapping(mapping: Dict[str, Any]) -> List[Path]:
    """Build hint paths from plugin args (Stash configuration.general from the UI)."""
    hints: List[Path] = []
    for key in (
        "stash_database_path",
        "stashDatabasePath",
        "database_path",
        "databasePath",
    ):
        value = mapping.get(key)
        if value not in (None, ""):
            hints.append(Path(str(value)))

    for key in (
        "stash_config_directory",
        "stashConfigDirectory",
        "stash_config_path",
        "stashConfigPath",
        "config_file_path",
        "configFilePath",
    ):
        value = mapping.get(key)
        if value not in (None, ""):
            cfg = Path(str(value)).expanduser()
            if cfg.is_file():
                parsed = _parse_database_from_config(cfg)
                if parsed:
                    hints.append(parsed)
            elif cfg.is_dir():
                hints.append(cfg)

    for key in ("stash_plugins_path", "pluginsPath", "plugins_path"):
        value = mapping.get(key)
        if value not in (None, ""):
            plugins = Path(str(value)).expanduser()
            if plugins.is_dir():
                hints.append(plugins.parent)

    return hints


def resolve_stash_sqlite_path(extra_paths: Optional[Sequence[Path]] = None) -> Optional[Path]:
    """Locate stash-go.sqlite (portable: env, Stash UI paths, config.yml, then $HOME/.stash/)."""
    explicit = os.environ.get("STASH_SQLITE_PATH") or os.environ.get("STASH_DATABASE_PATH")
    if explicit:
        path = Path(explicit).expanduser()
        if path.is_file():
            return path.resolve()

    for candidate in _sqlite_candidates_from_hints(extra_paths):
        return candidate

    seen: set[str] = set()
    for directory in _config_directories():
        key = str(directory.resolve())
        if key in seen:
            continue
        seen.add(key)

        from_config = _parse_database_from_config(directory / "config.yml")
        if from_config and from_config.is_file():
            return from_config.resolve()

        default_db = directory / "stash-go.sqlite"
        if default_db.is_file():
            return default_db.resolve()

    return None


def open_stash_sqlite_readonly(db_path: Path) -> sqlite3.Connection:
    """Open Stash DB read-only (works while Stash runs with WAL)."""
    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=120)
    except sqlite3.Error as exc:
        raise StashSqliteError(f"Cannot open {db_path}: {exc}") from exc
    connection.row_factory = sqlite3.Row
    return connection


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1",
        (name,),
    ).fetchone()
    return row is not None


def probe_stash_sqlite(db_path: Path) -> Dict[str, Any]:
    """Quick health check for UI / stats (does not build the agent index)."""
    try:
        with open_stash_sqlite_readonly(db_path) as connection:
            _require_schema(connection)
            row = connection.execute("SELECT COUNT(*) AS c FROM scenes").fetchone()
            scene_count = int(row["c"]) if row else 0
            return {"ok": True, "scene_count": scene_count}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _require_schema(connection: sqlite3.Connection) -> None:
    for table in ("scenes", "tags", "performers", "studios"):
        if not _table_exists(connection, table):
            raise StashSqliteError(f"Missing table '{table}' in Stash database.")


def _load_entity_rows(connection: sqlite3.Connection, table: str) -> List[Dict[str, str]]:
    rows = connection.execute(f"SELECT id, name FROM {table} WHERE name IS NOT NULL AND name != ''").fetchall()
    return [{"id": str(row["id"]), "name": str(row["name"])} for row in rows]


def _load_scene_tags(connection: sqlite3.Connection) -> Dict[int, str]:
    if not _table_exists(connection, "scenes_tags"):
        return {}
    mapping: Dict[int, List[str]] = {}
    cursor = connection.execute(
        """
        SELECT st.scene_id AS scene_id, t.name AS name
        FROM scenes_tags st
        INNER JOIN tags t ON t.id = st.tag_id
        ORDER BY st.scene_id, t.name
        """
    )
    for row in cursor:
        scene_id = int(row["scene_id"])
        mapping.setdefault(scene_id, []).append(str(row["name"]))
    return {scene_id: ", ".join(names) for scene_id, names in mapping.items()}


def _load_scene_performers(connection: sqlite3.Connection) -> Dict[int, str]:
    if not _table_exists(connection, "performers_scenes"):
        return {}
    mapping: Dict[int, List[str]] = {}
    cursor = connection.execute(
        """
        SELECT ps.scene_id AS scene_id, p.name AS name
        FROM performers_scenes ps
        INNER JOIN performers p ON p.id = ps.performer_id
        ORDER BY ps.scene_id, p.name
        """
    )
    for row in cursor:
        scene_id = int(row["scene_id"])
        mapping.setdefault(scene_id, []).append(str(row["name"]))
    return {scene_id: ", ".join(names) for scene_id, names in mapping.items()}


def _load_scene_files(connection: sqlite3.Connection) -> Dict[int, str]:
    if not _table_exists(connection, "scenes_files") or not _table_exists(connection, "files"):
        return {}
    if not _table_exists(connection, "folders"):
        return {}

    has_primary = False
    columns = connection.execute("PRAGMA table_info(scenes_files)").fetchall()
    for column in columns:
        if str(column["name"]).lower() == "primary":
            has_primary = True
            break

    primary_filter = 'AND sf."primary" = 1' if has_primary else ""
    mapping: Dict[int, str] = {}
    cursor = connection.execute(
        f"""
        SELECT sf.scene_id AS scene_id,
               folders.path AS folder_path,
               files.basename AS basename
        FROM scenes_files sf
        INNER JOIN files ON files.id = sf.file_id
        INNER JOIN folders ON folders.id = files.parent_folder_id
        WHERE 1=1 {primary_filter}
        ORDER BY sf.scene_id, files.size DESC
        """
    )
    for row in cursor:
        scene_id = int(row["scene_id"])
        if scene_id in mapping:
            continue
        folder = str(row["folder_path"] or "").strip()
        basename = str(row["basename"] or "").strip()
        if folder and basename:
            mapping[scene_id] = str(Path(folder) / basename)
        elif basename:
            mapping[scene_id] = basename
    return mapping


def _load_scene_play_stats(connection: sqlite3.Connection) -> Dict[int, Tuple[int, Optional[str]]]:
    if not _table_exists(connection, "scenes_view_dates"):
        return {}
    mapping: Dict[int, Tuple[int, Optional[str]]] = {}
    cursor = connection.execute(
        """
        SELECT scene_id,
               COUNT(*) AS play_count,
               MAX(view_date) AS last_played_at
        FROM scenes_view_dates
        GROUP BY scene_id
        """
    )
    for row in cursor:
        scene_id = int(row["scene_id"])
        play_count = int(row["play_count"] or 0)
        last_played = row["last_played_at"]
        mapping[scene_id] = (play_count, str(last_played) if last_played is not None else None)
    return mapping


def _iter_scene_rows(connection: sqlite3.Connection, batch_size: int = 5000) -> Iterator[Sequence[sqlite3.Row]]:
    cursor = connection.execute(
        """
        SELECT s.id AS id,
               s.title AS title,
               s.details AS details,
               s.rating AS rating,
               st.name AS studio_name
        FROM scenes s
        LEFT JOIN studios st ON st.id = s.studio_id
        ORDER BY s.id
        """
    )
    while True:
        batch = cursor.fetchmany(batch_size)
        if not batch:
            break
        yield batch


def build_agent_index_from_stash_sqlite(
    stash_db_path: Path,
    store: AgentIndexStore,
    config: AgentConfig,
    report_path: Optional[Any] = None,
    on_progress: ProgressCallback = None,
) -> Dict[str, Any]:
    """Build agent_library.db from Stash's stash-go.sqlite."""
    base = config.stash_base_url.rstrip("/")
    path = stash_db_path.expanduser().resolve()
    _report_progress(on_progress, f"Bibliotheks-Index aus Stash-SQLite (schnell): {path}")
    _report_progress(on_progress, f"Ziel: agent_library.db → {store.db_path}")

    with open_stash_sqlite_readonly(path) as connection:
        _require_schema(connection)
        _report_progress(on_progress, "Lade Tags, Performer, Studios und Dateipfade aus stash-go.sqlite …")
        tag_map = _load_scene_tags(connection)
        performer_map = _load_scene_performers(connection)
        file_map = _load_scene_files(connection)
        play_map = _load_scene_play_stats(connection)

        tags = _load_entity_rows(connection, "tags")
        performers = _load_entity_rows(connection, "performers")
        studios = _load_entity_rows(connection, "studios")
        _report_progress(
            on_progress,
            f"Metadaten geladen: {len(tags)} Tags, {len(performers)} Performer, {len(studios)} Studios.",
        )
        _report_progress(on_progress, "Schreibe Szenen in agent_library.db …")

        with store.connect() as agent_conn:
            store.initialize_schema(agent_conn)
            store.clear(agent_conn)
            store.set_meta(agent_conn, "generated_at", _utc_now_iso())
            store.set_meta(agent_conn, "stash_base_url", base)
            store.set_meta(agent_conn, "index_source", "stash_sqlite")
            store.set_meta(agent_conn, "stash_sqlite_path", str(path))
            store.set_meta(agent_conn, "graphql_query_variant", "agent_index_sqlite_v1")

            indexed = 0
            for batch in _iter_scene_rows(connection):
                for row in batch:
                    scene_id = int(row["id"])
                    scene_key = str(scene_id)
                    rating = row["rating"]
                    rating100 = int(rating) if rating is not None else None
                    play_count, last_played_at = play_map.get(scene_id, (0, None))
                    details = row["details"]
                    store.insert_scene(
                        agent_conn,
                        {
                            "id": scene_key,
                            "title": row["title"],
                            "file_path": file_map.get(scene_id),
                            "rating100": rating100,
                            "play_count": play_count,
                            "studio_name": row["studio_name"],
                            "last_played_at": last_played_at,
                            "tags_text": tag_map.get(scene_id, ""),
                            "performers_text": performer_map.get(scene_id, ""),
                            "details": (str(details) if details else "")[:2000],
                            "stash_url": f"{base}/scenes/{scene_key}",
                            "stream_url": f"{base}/scene/{scene_key}/stream",
                            "thumbnail": f"{base}/scene/{scene_key}/screenshot",
                        },
                    )
                    indexed += 1
                agent_conn.commit()
                if indexed <= 1 or indexed % 5000 == 0:
                    _report_progress(on_progress, f"… {indexed} Szenen in agent_library.db geschrieben")

            store.insert_entity_rows(agent_conn, "tags", tags)
            store.insert_entity_rows(agent_conn, "performers", performers)
            store.insert_entity_rows(agent_conn, "studios", studios)
            agent_conn.commit()

    stats = store.get_stats()
    result = {
        "message": (
            f"Agent library index built from Stash SQLite: {stats['scene_count']} scenes, "
            f"{stats['tag_count']} tags, {stats['performer_count']} performers, "
            f"{stats['studio_count']} studios."
        ),
        "index": stats,
        "db_path": str(store.db_path),
        "index_source": "stash_sqlite",
        "stash_sqlite_path": str(path),
    }
    if report_path is not None:
        store.write_build_report(report_path, result)
    _report_progress(on_progress, result["message"])
    return result
