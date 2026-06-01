from __future__ import annotations

from typing import Any, Dict, Optional

import requests


class StashAgentError(Exception):
    """User-facing agent API error."""


class StashAgentClient:
    def __init__(self, graphql_url: str, api_key: Optional[str] = None) -> None:
        self.url = graphql_url
        self.headers: Dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            self.headers["ApiKey"] = api_key
            self.headers["Authorization"] = f"Bearer {api_key}"

    def execute(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body = {"query": query, "variables": variables or {}}
        try:
            response = requests.post(self.url, json=body, headers=self.headers, timeout=120)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise StashAgentError(f"GraphQL request failed ({self.url}): {exc}") from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise StashAgentError("Stash returned non-JSON GraphQL response.") from exc

        if payload.get("errors"):
            messages = "; ".join(str(item.get("message", item)) for item in payload["errors"])
            raise StashAgentError(messages)

        data = payload.get("data")
        if not isinstance(data, dict):
            raise StashAgentError("GraphQL response missing 'data'.")
        return data
