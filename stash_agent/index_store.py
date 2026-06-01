from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentIndexStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def exists(self) -> bool:
        return self.db_path.is_file() and self.db_path.stat().st_size > 0

    def connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.db_path))
        connection.row_factory = sqlite3.Row
        return connection

    def initialize_schema(self, connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scenes (
              id TEXT PRIMARY KEY,
              title TEXT,
              file_path TEXT,
              rating100 INTEGER,
              play_count INTEGER,
              studio_name TEXT,
              last_played_at TEXT,
              tags_text TEXT,
              performers_text TEXT,
              details TEXT,
              stash_url TEXT,
              stream_url TEXT,
              thumbnail TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS scenes_fts USING fts5(
              title,
              file_path,
              tags_text,
              performers_text,
              studio_name,
              details,
              tokenize='unicode61'
            );
            CREATE TABLE IF NOT EXISTS tags (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS performers (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS studios (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL
            );
            """
        )

    def begin_build(self, *, stash_base_url: str, index_source: str = "pending") -> None:
        """Create agent_library.db immediately so long-running scans show a file on disk."""
        with self.connect() as connection:
            self.initialize_schema(connection)
            self.clear(connection)
            self.set_meta(connection, "generated_at", _utc_now_iso())
            self.set_meta(connection, "stash_base_url", stash_base_url)
            self.set_meta(connection, "index_source", index_source)
            self.set_meta(connection, "build_status", "in_progress")
            connection.commit()

    def clear(self, connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            DELETE FROM scenes;
            DELETE FROM scenes_fts;
            DELETE FROM tags;
            DELETE FROM performers;
            DELETE FROM studios;
            DELETE FROM meta;
            """
        )

    def set_meta(self, connection: sqlite3.Connection, key: str, value: str) -> None:
        connection.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def get_meta(self, connection: sqlite3.Connection, key: str) -> Optional[str]:
        row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def insert_scene(self, connection: sqlite3.Connection, scene: Dict[str, Any]) -> None:
        cursor = connection.execute(
            """
            INSERT INTO scenes(
              id, title, file_path, rating100, play_count, studio_name, last_played_at,
              tags_text, performers_text, details, stash_url, stream_url, thumbnail
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                scene["id"],
                scene.get("title"),
                scene.get("file_path"),
                scene.get("rating100"),
                scene.get("play_count"),
                scene.get("studio_name"),
                scene.get("last_played_at"),
                scene.get("tags_text"),
                scene.get("performers_text"),
                scene.get("details"),
                scene.get("stash_url"),
                scene.get("stream_url"),
                scene.get("thumbnail"),
            ),
        )
        rowid = cursor.lastrowid
        connection.execute(
            """
            INSERT INTO scenes_fts(
              rowid, title, file_path, tags_text, performers_text, studio_name, details
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rowid,
                scene.get("title") or "",
                scene.get("file_path") or "",
                scene.get("tags_text") or "",
                scene.get("performers_text") or "",
                scene.get("details") or "",
                scene.get("studio_name") or "",
            ),
        )

    def insert_entity_rows(
        self,
        connection: sqlite3.Connection,
        table: str,
        rows: List[Dict[str, str]],
    ) -> None:
        for row in rows:
            connection.execute(
                f"INSERT OR REPLACE INTO {table}(id, name) VALUES (?, ?)",
                (row["id"], row["name"]),
            )

    def get_stats(self) -> Dict[str, Any]:
        if not self.exists():
            return {
                "ready": False,
                "db_path": str(self.db_path),
                "scene_count": 0,
                "tag_count": 0,
                "performer_count": 0,
                "studio_count": 0,
            }

        with self.connect() as connection:
            scene_count = connection.execute("SELECT COUNT(*) AS c FROM scenes").fetchone()["c"]
            tag_count = connection.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"]
            performer_count = connection.execute("SELECT COUNT(*) AS c FROM performers").fetchone()["c"]
            studio_count = connection.execute("SELECT COUNT(*) AS c FROM studios").fetchone()["c"]
            return {
                "ready": scene_count > 0,
                "db_path": str(self.db_path),
                "generated_at": self.get_meta(connection, "generated_at"),
                "stash_base_url": self.get_meta(connection, "stash_base_url"),
                "graphql_query_variant": self.get_meta(connection, "graphql_query_variant"),
                "index_source": self.get_meta(connection, "index_source"),
                "stash_sqlite_path": self.get_meta(connection, "stash_sqlite_path"),
                "scene_count": int(scene_count),
                "tag_count": int(tag_count),
                "performer_count": int(performer_count),
                "studio_count": int(studio_count),
            }

    def _row_to_scene(self, row: sqlite3.Row) -> Dict[str, Any]:
        rating100 = row["rating100"]
        rating = round(rating100 / 20, 2) if isinstance(rating100, int) and rating100 else None
        tags = [part.strip() for part in (row["tags_text"] or "").split(",") if part.strip()]
        performers = [part.strip() for part in (row["performers_text"] or "").split(",") if part.strip()]
        return {
            "id": row["id"],
            "title": row["title"] or row["file_path"] or f"Scene {row['id']}",
            "file_path": row["file_path"],
            "rating": rating,
            "rating100": rating100,
            "play_count": row["play_count"] or 0,
            "studio": row["studio_name"],
            "last_played_at": row["last_played_at"],
            "tags": tags,
            "performers": performers,
            "stash_url": row["stash_url"],
            "stream_url": row["stream_url"],
            "thumbnail": row["thumbnail"],
            "reason": "Agent library index",
        }

    def search(self, query: str, limit: int = 12) -> List[Dict[str, Any]]:
        if not self.exists():
            return []

        cleaned = query.strip()
        limit = max(1, min(int(limit), 50))
        with self.connect() as connection:
            if not cleaned:
                rows = connection.execute(
                    """
                    SELECT * FROM scenes
                    ORDER BY COALESCE(rating100, 0) DESC, COALESCE(play_count, 0) DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                return [self._row_to_scene(row) for row in rows]

            rows = connection.execute(
                """
                SELECT s.*
                FROM scenes_fts fts
                JOIN scenes s ON s.rowid = fts.rowid
                WHERE scenes_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (self._fts_query(cleaned), limit),
            ).fetchall()
            if rows:
                return [self._row_to_scene(row) for row in rows]

            like = f"%{cleaned}%"
            rows = connection.execute(
                """
                SELECT * FROM scenes
                WHERE title LIKE ? OR file_path LIKE ? OR tags_text LIKE ?
                   OR performers_text LIKE ? OR studio_name LIKE ? OR details LIKE ?
                ORDER BY COALESCE(rating100, 0) DESC
                LIMIT ?
                """,
                (like, like, like, like, like, like, limit),
            ).fetchall()
            return [self._row_to_scene(row) for row in rows]

    def top_tags(self, limit: int = 10) -> List[Dict[str, Any]]:
        if not self.exists():
            return []
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT t.name AS name, COUNT(*) AS scene_count
                FROM tags t
                JOIN scenes s ON (',' || s.tags_text || ',') LIKE ('%,' || t.name || ',%')
                GROUP BY t.name
                ORDER BY scene_count DESC, t.name ASC
                LIMIT ?
                """,
                (max(1, min(limit, 50)),),
            ).fetchall()
            return [{"name": row["name"], "scene_count": row["scene_count"]} for row in rows]

    @staticmethod
    def _fts_query(text: str) -> str:
        parts = [part for part in text.replace('"', " ").split() if part.strip()]
        if not parts:
            return text
        return " ".join(f'"{part}"*' for part in parts)

    def export_summary(self) -> Dict[str, Any]:
        stats = self.get_stats()
        if not stats.get("ready"):
            return stats
        with self.connect() as connection:
            sample = connection.execute(
                """
                SELECT id, title, studio_name, rating100, tags_text
                FROM scenes
                ORDER BY COALESCE(rating100, 0) DESC
                LIMIT 5
                """
            ).fetchall()
            stats["top_tags"] = self.top_tags(8)
            stats["sample_high_rated"] = [
                {
                    "id": row["id"],
                    "title": row["title"],
                    "studio": row["studio_name"],
                    "rating100": row["rating100"],
                    "tags": row["tags_text"],
                }
                for row in sample
            ]
        return stats

    def write_build_report(self, path: Path, payload: Dict[str, Any]) -> None:
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
