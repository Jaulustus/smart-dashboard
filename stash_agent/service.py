from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Sequence

from stash_agent.agent_chat import agent_chat
from stash_agent.client import StashAgentClient, StashAgentError
from stash_agent.config import AgentConfig
from stash_agent.index_builder import build_agent_index
from stash_agent.index_store import AgentIndexStore

ListMode = Literal["set", "add", "remove"]


SCENE_DETAIL_QUERY = """
query StashAgentScene($id: ID!) {
  findScene(id: $id) {
    id
    title
    details
    date
    rating100
    organized
    o_counter
    play_count
    last_played_at
    urls
    paths { screenshot stream }
    files { path width height duration }
    tags { id name }
    performers { id name }
    studio { id name }
    galleries { id title }
  }
}
"""

FIND_SCENES_QUERY = """
query StashAgentFindScenes($filter: FindFilterType!) {
  findScenes(filter: $filter) {
    count
    scenes {
      id
      title
      rating100
      play_count
      last_played_at
      paths { screenshot }
      files { path width height duration }
      tags { id name }
      performers { id name }
      studio { id name }
    }
  }
}
"""

FIND_TAGS_QUERY = """
query StashAgentFindTags($filter: FindFilterType!) {
  findTags(filter: $filter) {
    count
    tags { id name description sort_name aliases }
  }
}
"""

FIND_PERFORMERS_QUERY = """
query StashAgentFindPerformers($filter: FindFilterType!) {
  findPerformers(filter: $filter) {
    count
    performers { id name disambiguation gender favorite }
  }
}
"""

FIND_STUDIOS_QUERY = """
query StashAgentFindStudios($filter: FindFilterType!) {
  findStudios(filter: $filter) {
    count
    studios { id name url details favorite }
  }
}
"""

SCENE_UPDATE_MUTATION = """
mutation StashAgentSceneUpdate($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) {
    id
    title
    rating100
    tags { id name }
    performers { id name }
    studio { id name }
  }
}
"""

TAG_CREATE_MUTATION = """
mutation StashAgentTagCreate($input: TagCreateInput!) {
  tagCreate(input: $input) {
    id
    name
  }
}
"""

PERFORMER_CREATE_MUTATION = """
mutation StashAgentPerformerCreate($input: PerformerCreateInput!) {
  performerCreate(input: $input) {
    id
    name
  }
}
"""

STUDIO_CREATE_MUTATION = """
mutation StashAgentStudioCreate($input: StudioCreateInput!) {
  studioCreate(input: $input) {
    id
    name
  }
}
"""


def _first_file_path(scene: Dict[str, Any]) -> Optional[str]:
    files = scene.get("files")
    if isinstance(files, list) and files:
        path = files[0].get("path") if isinstance(files[0], dict) else None
        return str(path) if path else None
    legacy = scene.get("file")
    if isinstance(legacy, dict) and legacy.get("path"):
        return str(legacy["path"])
    return None


def _file_stem(path: Optional[str]) -> str:
    if not path:
        return ""
    name = path.replace("\\", "/").split("/")[-1]
    if "." in name:
        return name.rsplit(".", 1)[0]
    return name


def _is_untitled(title: Optional[str]) -> bool:
    if not title:
        return True
    normalized = str(title).strip().lower()
    return normalized in {"", "untitled", "unknown"}


def _entity_names(items: Any) -> List[str]:
    if not isinstance(items, list):
        return []
    names: List[str] = []
    for item in items:
        if isinstance(item, dict) and item.get("name"):
            names.append(str(item["name"]))
    return names


def _entity_ids(items: Any) -> List[str]:
    if not isinstance(items, list):
        return []
    ids: List[str] = []
    for item in items:
        if isinstance(item, dict) and item.get("id") is not None:
            ids.append(str(item["id"]))
    return ids


def _merge_id_list(
    current: Sequence[str],
    incoming: Sequence[str],
    mode: ListMode,
) -> List[str]:
    current_list = list(current)
    incoming_list = [str(value) for value in incoming]
    if mode == "set":
        return incoming_list
    if mode == "add":
        merged = list(current_list)
        for value in incoming_list:
            if value not in merged:
                merged.append(value)
        return merged
    if mode == "remove":
        remove_set = set(incoming_list)
        return [value for value in current_list if value not in remove_set]
    raise StashAgentError(f"Unsupported list mode: {mode}")


class StashAgentService:
    def __init__(self, client: StashAgentClient, config: AgentConfig) -> None:
        self.client = client
        self.config = config

    @classmethod
    def from_config(cls, config: Optional[AgentConfig] = None) -> "StashAgentService":
        cfg = config or AgentConfig.from_env()
        return cls(StashAgentClient(cfg.graphql_url, cfg.api_key), cfg)

    def _scene_summary(self, scene: Dict[str, Any], index: int = 0) -> Dict[str, Any]:
        file_path = _first_file_path(scene)
        title = scene.get("title")
        display_title = title if not _is_untitled(title) else (_file_stem(file_path) or f"Scene {scene.get('id')}")
        paths = scene.get("paths") if isinstance(scene.get("paths"), dict) else {}
        screenshot = paths.get("screenshot")
        stream = paths.get("stream")
        base = self.config.stash_base_url.rstrip("/")
        scene_id = str(scene.get("id", ""))
        first_file = scene.get("files")[0] if isinstance(scene.get("files"), list) and scene.get("files") else {}
        width = first_file.get("width") if isinstance(first_file, dict) else None
        height = first_file.get("height") if isinstance(first_file, dict) else None
        rating100 = scene.get("rating100")
        return {
            "id": scene_id,
            "title": display_title,
            "stash_title": title,
            "file_path": file_path,
            "rating": round(rating100 / 20, 2) if isinstance(rating100, (int, float)) else None,
            "rating100": rating100,
            "play_count": scene.get("play_count"),
            "last_played_at": scene.get("last_played_at"),
            "tags": _entity_names(scene.get("tags")),
            "tag_ids": _entity_ids(scene.get("tags")),
            "performers": _entity_names(scene.get("performers")),
            "performer_ids": _entity_ids(scene.get("performers")),
            "studio": (scene.get("studio") or {}).get("name") if isinstance(scene.get("studio"), dict) else None,
            "studio_id": (scene.get("studio") or {}).get("id") if isinstance(scene.get("studio"), dict) else None,
            "resolution": f"{width}x{height}" if width and height else None,
            "thumbnail": screenshot,
            "stream_url": stream or (f"{base}/scene/{scene_id}/stream" if scene_id else None),
            "stash_url": f"{base}/scenes/{scene_id}" if scene_id else None,
            "update_url": f"{base}/scenes/{scene_id}/update" if scene_id else None,
            "index": index,
        }

    def get_library_stats(self) -> Dict[str, Any]:
        data = self.client.execute(
            FIND_SCENES_QUERY,
            {"filter": {"page": 1, "per_page": 1}},
        )
        container = data.get("findScenes") or {}
        return {
            "total_scenes": int(container.get("count") or 0),
            "stash_base_url": self.config.stash_base_url,
            "graphql_url": self.config.graphql_url,
        }

    def search_scenes(
        self,
        query: Optional[str] = None,
        tag_names: Optional[Sequence[str]] = None,
        performer_names: Optional[Sequence[str]] = None,
        studio_name: Optional[str] = None,
        page: int = 1,
        per_page: int = 40,
        sort: str = "date",
        direction: str = "DESC",
    ) -> Dict[str, Any]:
        per_page = max(1, min(int(per_page), 500))
        page = max(1, int(page))
        scene_filter: Dict[str, Any] = {
            "page": page,
            "per_page": per_page,
            "sort": sort,
            "direction": direction,
        }
        if query and str(query).strip():
            scene_filter["q"] = str(query).strip()

        if tag_names:
            tag_ids = self.resolve_tag_ids(tag_names)
            if tag_ids:
                scene_filter["tags"] = {"value": tag_ids, "modifier": "INCLUDES"}

        if performer_names:
            performer_ids = self.resolve_performer_ids(performer_names)
            if performer_ids:
                scene_filter["performers"] = {"value": performer_ids, "modifier": "INCLUDES"}

        if studio_name and str(studio_name).strip():
            studio_ids = self.resolve_studio_ids([studio_name])
            if studio_ids:
                scene_filter["studios"] = {"value": studio_ids, "modifier": "INCLUDES"}

        data = self.client.execute(FIND_SCENES_QUERY, {"filter": scene_filter})
        container = data.get("findScenes") or {}
        scenes = container.get("scenes") or []
        start_index = (page - 1) * per_page
        items = [self._scene_summary(scene, start_index + index) for index, scene in enumerate(scenes)]
        return {
            "count": int(container.get("count") or len(items)),
            "page": page,
            "per_page": per_page,
            "scenes": items,
        }

    def get_scene(self, scene_id: str) -> Dict[str, Any]:
        data = self.client.execute(SCENE_DETAIL_QUERY, {"id": str(scene_id)})
        scene = data.get("findScene")
        if not scene:
            raise StashAgentError(f"Scene not found: {scene_id}")
        summary = self._scene_summary(scene)
        summary["details"] = scene.get("details")
        summary["date"] = scene.get("date")
        summary["organized"] = scene.get("organized")
        summary["urls"] = scene.get("urls") or []
        summary["galleries"] = [
            {"id": g.get("id"), "title": g.get("title")}
            for g in (scene.get("galleries") or [])
            if isinstance(g, dict)
        ]
        return summary

    def update_scene(
        self,
        scene_id: str,
        title: Optional[str] = None,
        details: Optional[str] = None,
        date: Optional[str] = None,
        rating100: Optional[int] = None,
        organized: Optional[bool] = None,
        studio_id: Optional[str] = None,
        studio_name: Optional[str] = None,
        tag_ids: Optional[Sequence[str]] = None,
        tag_names: Optional[Sequence[str]] = None,
        tag_mode: ListMode = "set",
        performer_ids: Optional[Sequence[str]] = None,
        performer_names: Optional[Sequence[str]] = None,
        performer_mode: ListMode = "set",
        clear_studio: bool = False,
    ) -> Dict[str, Any]:
        current = self.get_scene(scene_id)
        update_input: Dict[str, Any] = {"id": str(scene_id)}

        if title is not None:
            update_input["title"] = title
        if details is not None:
            update_input["details"] = details
        if date is not None:
            update_input["date"] = date
        if rating100 is not None:
            update_input["rating100"] = int(rating100)
        if organized is not None:
            update_input["organized"] = bool(organized)

        resolved_tag_ids: Optional[List[str]] = None
        if tag_ids is not None:
            resolved_tag_ids = [str(value) for value in tag_ids]
        elif tag_names:
            resolved_tag_ids = self.resolve_tag_ids(tag_names, create_missing=True)

        if resolved_tag_ids is not None:
            update_input["tag_ids"] = _merge_id_list(
                current.get("tag_ids") or [],
                resolved_tag_ids,
                tag_mode,
            )

        resolved_performer_ids: Optional[List[str]] = None
        if performer_ids is not None:
            resolved_performer_ids = [str(value) for value in performer_ids]
        elif performer_names:
            resolved_performer_ids = self.resolve_performer_ids(performer_names, create_missing=True)

        if resolved_performer_ids is not None:
            update_input["performer_ids"] = _merge_id_list(
                current.get("performer_ids") or [],
                resolved_performer_ids,
                performer_mode,
            )

        if clear_studio:
            update_input["studio_id"] = None
        elif studio_id is not None:
            update_input["studio_id"] = str(studio_id)
        elif studio_name:
            ids = self.resolve_studio_ids([studio_name], create_missing=True)
            if not ids:
                raise StashAgentError(f"Studio not found: {studio_name}")
            update_input["studio_id"] = ids[0]

        data = self.client.execute(SCENE_UPDATE_MUTATION, {"input": update_input})
        updated = data.get("sceneUpdate")
        if not updated:
            raise StashAgentError("sceneUpdate returned no scene.")
        return self._scene_summary(updated)

    def search_tags(self, query: str = "", page: int = 1, per_page: int = 40) -> Dict[str, Any]:
        per_page = max(1, min(int(per_page), 500))
        page = max(1, int(page))
        tag_filter: Dict[str, Any] = {"page": page, "per_page": per_page, "sort": "name", "direction": "ASC"}
        if query and str(query).strip():
            tag_filter["q"] = str(query).strip()
        data = self.client.execute(FIND_TAGS_QUERY, {"filter": tag_filter})
        container = data.get("findTags") or {}
        tags = container.get("tags") or []
        return {
            "count": int(container.get("count") or len(tags)),
            "page": page,
            "per_page": per_page,
            "tags": [
                {
                    "id": str(tag.get("id")),
                    "name": tag.get("name"),
                    "description": tag.get("description"),
                    "aliases": tag.get("aliases") or [],
                }
                for tag in tags
                if isinstance(tag, dict)
            ],
        }

    def search_performers(self, query: str = "", page: int = 1, per_page: int = 40) -> Dict[str, Any]:
        per_page = max(1, min(int(per_page), 500))
        page = max(1, int(page))
        performer_filter: Dict[str, Any] = {"page": page, "per_page": per_page, "sort": "name", "direction": "ASC"}
        if query and str(query).strip():
            performer_filter["q"] = str(query).strip()
        data = self.client.execute(FIND_PERFORMERS_QUERY, {"filter": performer_filter})
        container = data.get("findPerformers") or {}
        performers = container.get("performers") or []
        return {
            "count": int(container.get("count") or len(performers)),
            "page": page,
            "per_page": per_page,
            "performers": [
                {
                    "id": str(performer.get("id")),
                    "name": performer.get("name"),
                    "disambiguation": performer.get("disambiguation"),
                    "gender": performer.get("gender"),
                }
                for performer in performers
                if isinstance(performer, dict)
            ],
        }

    def search_studios(self, query: str = "", page: int = 1, per_page: int = 40) -> Dict[str, Any]:
        per_page = max(1, min(int(per_page), 500))
        page = max(1, int(page))
        studio_filter: Dict[str, Any] = {"page": page, "per_page": per_page, "sort": "name", "direction": "ASC"}
        if query and str(query).strip():
            studio_filter["q"] = str(query).strip()
        data = self.client.execute(FIND_STUDIOS_QUERY, {"filter": studio_filter})
        container = data.get("findStudios") or {}
        studios = container.get("studios") or []
        return {
            "count": int(container.get("count") or len(studios)),
            "page": page,
            "per_page": per_page,
            "studios": [
                {
                    "id": str(studio.get("id")),
                    "name": studio.get("name"),
                    "url": studio.get("url"),
                }
                for studio in studios
                if isinstance(studio, dict)
            ],
        }

    def resolve_tag_ids(self, names: Sequence[str], create_missing: bool = False) -> List[str]:
        ids: List[str] = []
        for name in names:
            name = str(name).strip()
            if not name:
                continue
            found = self.search_tags(name, per_page=10)
            exact = next(
                (tag for tag in found.get("tags", []) if str(tag.get("name", "")).lower() == name.lower()),
                None,
            )
            if exact:
                ids.append(str(exact["id"]))
                continue
            if create_missing:
                created = self.client.execute(TAG_CREATE_MUTATION, {"input": {"name": name}})
                tag = created.get("tagCreate")
                if tag and tag.get("id"):
                    ids.append(str(tag["id"]))
                    continue
            raise StashAgentError(f"Tag not found: {name}")
        return ids

    def resolve_performer_ids(self, names: Sequence[str], create_missing: bool = False) -> List[str]:
        ids: List[str] = []
        for name in names:
            name = str(name).strip()
            if not name:
                continue
            found = self.search_performers(name, per_page=10)
            exact = next(
                (
                    performer
                    for performer in found.get("performers", [])
                    if str(performer.get("name", "")).lower() == name.lower()
                ),
                None,
            )
            if exact:
                ids.append(str(exact["id"]))
                continue
            if create_missing:
                created = self.client.execute(PERFORMER_CREATE_MUTATION, {"input": {"name": name}})
                performer = created.get("performerCreate")
                if performer and performer.get("id"):
                    ids.append(str(performer["id"]))
                    continue
            raise StashAgentError(f"Performer not found: {name}")
        return ids

    def resolve_studio_ids(self, names: Sequence[str], create_missing: bool = False) -> List[str]:
        ids: List[str] = []
        for name in names:
            name = str(name).strip()
            if not name:
                continue
            found = self.search_studios(name, per_page=10)
            exact = next(
                (studio for studio in found.get("studios", []) if str(studio.get("name", "")).lower() == name.lower()),
                None,
            )
            if exact:
                ids.append(str(exact["id"]))
                continue
            if create_missing:
                created = self.client.execute(STUDIO_CREATE_MUTATION, {"input": {"name": name}})
                studio = created.get("studioCreate")
                if studio and studio.get("id"):
                    ids.append(str(studio["id"]))
                    continue
            raise StashAgentError(f"Studio not found: {name}")
        return ids

    def list_duplicate_groups(self, limit: int = 20) -> Dict[str, Any]:
        path = self.config.duplicates_report
        if not path.exists():
            return {
                "available": False,
                "message": f"No duplicate report at {path}. Run smart_dup_scan in Stash first.",
                "groups": [],
            }
        with path.open(encoding="utf-8") as handle:
            report = json.load(handle)
        groups = report.get("duplicate_groups") or report.get("groups") or []
        if not isinstance(groups, list):
            groups = []
        trimmed = groups[: max(1, min(int(limit), 100))]
        return {
            "available": True,
            "report_path": str(path),
            "generated_at": report.get("generated_at"),
            "group_count": len(groups),
            "groups": trimmed,
        }

    def index_store(self) -> AgentIndexStore:
        return AgentIndexStore(self.config.agent_index_db)

    def get_agent_index_stats(self) -> Dict[str, Any]:
        return self.index_store().export_summary()

    def build_agent_index(self) -> Dict[str, Any]:
        return build_agent_index(
            self.client,
            self.index_store(),
            self.config,
            report_path=self.config.agent_index_report,
        )

    def agent_chat(self, message: str, language: Optional[str] = None, limit: int = 12) -> Dict[str, Any]:
        return agent_chat(self.index_store(), message, language=language, limit=limit)
