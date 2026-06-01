#!/usr/bin/env python3
"""REST-style HTTP API for Stash agent integrations (OpenClaw, scripts, n8n).

Start:
  python stash_http_server.py

Environment:
  STASH_GRAPHQL_URL, STASH_API_KEY
  STASH_AGENT_HTTP_HOST (default 127.0.0.1)
  STASH_AGENT_HTTP_PORT (default 8765)
  STASH_AGENT_HTTP_TOKEN (optional Bearer token)
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from stash_agent.client import StashAgentError
from stash_agent.config import AgentConfig
from stash_agent.service import StashAgentService

SERVICE = StashAgentService.from_config()
CONFIG = AgentConfig.from_env()


def _parse_json_body(handler: BaseHTTPRequestHandler) -> Dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    data = json.loads(raw.decode("utf-8"))
    return data if isinstance(data, dict) else {}


def _query_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return None


def _split_names(values: Any) -> Optional[list[str]]:
    if values is None:
        return None
    if isinstance(values, list):
        return [str(item) for item in values if str(item).strip()]
    text = str(values).strip()
    if not text:
        return None
    return [part.strip() for part in text.split(",") if part.strip()]


class StashAgentHandler(BaseHTTPRequestHandler):
    server_version = "StashAgentHTTP/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _authorized(self) -> bool:
        if not CONFIG.http_token:
            return True
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {CONFIG.http_token}":
            return True
        token = self.headers.get("X-Stash-Agent-Token", "")
        return token == CONFIG.http_token

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _reject_unauthorized(self) -> None:
        self._send(401, {"ok": False, "error": "Unauthorized"})

    def _handle_error(self, exc: Exception) -> None:
        if isinstance(exc, StashAgentError):
            self._send(400, {"ok": False, "error": str(exc)})
            return
        if isinstance(exc, json.JSONDecodeError):
            self._send(400, {"ok": False, "error": "Invalid JSON body"})
            return
        self._send(500, {"ok": False, "error": str(exc)})

    def _route_get(self) -> Tuple[int, Dict[str, Any]]:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)

        def q(name: str, default: str = "") -> str:
            values = qs.get(name)
            return values[0] if values else default

        def q_int(name: str, default: int) -> int:
            try:
                return int(q(name, str(default)))
            except ValueError:
                return default

        if path in {"/", "/health"}:
            return 200, {"ok": True, "service": "stash-agent", "stash_base_url": CONFIG.stash_base_url}

        if path == "/v1/library/stats":
            return 200, {"ok": True, "data": SERVICE.get_library_stats()}

        if path == "/v1/scenes":
            result = SERVICE.search_scenes(
                query=q("q") or None,
                tag_names=_split_names(qs.get("tag")),
                performer_names=_split_names(qs.get("performer")),
                studio_name=q("studio") or None,
                page=q_int("page", 1),
                per_page=q_int("per_page", 40),
                sort=q("sort", "date"),
                direction=q("direction", "DESC"),
            )
            return 200, {"ok": True, "data": result}

        if path.startswith("/v1/scenes/") and path.count("/") == 3:
            scene_id = path.split("/")[-1]
            return 200, {"ok": True, "data": SERVICE.get_scene(scene_id)}

        if path == "/v1/tags":
            return 200, {
                "ok": True,
                "data": SERVICE.search_tags(query=q("q"), page=q_int("page", 1), per_page=q_int("per_page", 40)),
            }

        if path == "/v1/performers":
            return 200, {
                "ok": True,
                "data": SERVICE.search_performers(
                    query=q("q"), page=q_int("page", 1), per_page=q_int("per_page", 40)
                ),
            }

        if path == "/v1/studios":
            return 200, {
                "ok": True,
                "data": SERVICE.search_studios(query=q("q"), page=q_int("page", 1), per_page=q_int("per_page", 40)),
            }

        if path == "/v1/duplicates":
            return 200, {"ok": True, "data": SERVICE.list_duplicate_groups(limit=q_int("limit", 20))}

        return 404, {"ok": False, "error": f"Unknown path: {path}"}

    def _route_post(self) -> Tuple[int, Dict[str, Any]]:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        body = _parse_json_body(self)

        if path.startswith("/v1/scenes/") and path.endswith("/update"):
            scene_id = path.split("/")[3]
            return 200, {
                "ok": True,
                "data": SERVICE.update_scene(
                    scene_id=scene_id,
                    title=body.get("title"),
                    details=body.get("details"),
                    date=body.get("date"),
                    rating100=body.get("rating100"),
                    organized=body.get("organized") if "organized" in body else None,
                    studio_id=body.get("studio_id"),
                    studio_name=body.get("studio_name"),
                    clear_studio=bool(body.get("clear_studio")),
                    tag_ids=body.get("tag_ids"),
                    tag_names=body.get("tag_names"),
                    tag_mode=body.get("tag_mode", "add"),
                    performer_ids=body.get("performer_ids"),
                    performer_names=body.get("performer_names"),
                    performer_mode=body.get("performer_mode", "add"),
                ),
            }

        return 404, {"ok": False, "error": f"Unknown path: {path}"}

    def do_GET(self) -> None:
        if not self._authorized():
            self._reject_unauthorized()
            return
        try:
            status, payload = self._route_get()
            self._send(status, payload)
        except Exception as exc:
            self._handle_error(exc)

    def do_POST(self) -> None:
        if not self._authorized():
            self._reject_unauthorized()
            return
        try:
            status, payload = self._route_post()
            self._send(status, payload)
        except Exception as exc:
            self._handle_error(exc)


def main() -> None:
    address = (CONFIG.http_host, CONFIG.http_port)
    httpd = ThreadingHTTPServer(address, StashAgentHandler)
    print(
        f"Stash Agent HTTP API listening on http://{CONFIG.http_host}:{CONFIG.http_port}",
        file=sys.stderr,
    )
    print(f"GraphQL: {CONFIG.graphql_url}", file=sys.stderr)
    if CONFIG.http_token:
        print("Auth: Bearer token required", file=sys.stderr)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
