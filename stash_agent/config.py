from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


PLUGIN_DIR = Path(__file__).resolve().parent.parent
DEFAULT_GRAPHQL_URL = "http://localhost:9999/graphql"


@dataclass(frozen=True)
class AgentConfig:
    graphql_url: str
    api_key: Optional[str]
    http_host: str
    http_port: int
    http_token: Optional[str]
    duplicates_report: Path
    agent_index_db: Path
    agent_index_report: Path
    stash_sqlite_path: Optional[Path]

    @classmethod
    def from_env(cls) -> "AgentConfig":
        graphql_url = (
            os.environ.get("STASH_GRAPHQL_URL")
            or os.environ.get("STASH_GRAPHQL_ENDPOINT")
            or DEFAULT_GRAPHQL_URL
        ).strip()
        if graphql_url.endswith("/"):
            graphql_url = graphql_url.rstrip("/")
        if not graphql_url.endswith("/graphql"):
            base = graphql_url.rstrip("/")
            graphql_url = base if base.endswith("/graphql") else f"{base}/graphql"

        api_key = os.environ.get("STASH_API_KEY") or os.environ.get("STASH_APIKEY")
        api_key = api_key.strip() if api_key else None

        http_host = os.environ.get("STASH_AGENT_HTTP_HOST", "127.0.0.1").strip() or "127.0.0.1"
        http_port = int(os.environ.get("STASH_AGENT_HTTP_PORT", "8765"))
        http_token = os.environ.get("STASH_AGENT_HTTP_TOKEN")
        http_token = http_token.strip() if http_token else None

        report = os.environ.get("STASH_DUPLICATES_REPORT")
        duplicates_report = Path(report) if report else PLUGIN_DIR / "duplicates_report.json"
        index_db = os.environ.get("STASH_AGENT_INDEX_DB")
        index_report = os.environ.get("STASH_AGENT_INDEX_REPORT")
        sqlite_path = os.environ.get("STASH_SQLITE_PATH") or os.environ.get("STASH_DATABASE_PATH")
        stash_sqlite = Path(sqlite_path).expanduser() if sqlite_path else None

        return cls(
            graphql_url=graphql_url.replace("://0.0.0.0", "://localhost"),
            api_key=api_key,
            http_host=http_host,
            http_port=http_port,
            http_token=http_token,
            duplicates_report=duplicates_report,
            agent_index_db=Path(index_db) if index_db else PLUGIN_DIR / "agent_library.db",
            agent_index_report=Path(index_report) if index_report else PLUGIN_DIR / "agent_index_report.json",
            stash_sqlite_path=stash_sqlite,
        )

    @property
    def stash_base_url(self) -> str:
        url = self.graphql_url.rstrip("/")
        if url.endswith("/graphql"):
            return url[: -len("/graphql")]
        return url
