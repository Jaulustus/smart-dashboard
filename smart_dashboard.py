#!/usr/bin/env python3
"""Backend for the Smart Dashboard & Advanced Duplicate Finder Stash plugin.

Stash invokes raw plugins as a process and expects one JSON object on stdout.
Diagnostics are written to stderr so stdout stays parseable by Stash.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import subprocess
import sys
import traceback
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


PLUGIN_NAME = "Smart Dashboard & Advanced Duplicate Finder"
AUTHOR = "Jaulustus"
DEFAULT_STASH_GRAPHQL_URL = "http://localhost:9999/graphql"
PLUGIN_DIR = Path(__file__).resolve().parent
CACHE_DB = PLUGIN_DIR / "cache.db"
DUPLICATES_REPORT = PLUGIN_DIR / "duplicates_report.json"
RECOMMENDATIONS_REPORT = PLUGIN_DIR / "recommendations.json"
REQUIREMENTS_FILE = PLUGIN_DIR / "requirements.txt"
DASHBOARD_DEEP_LINK = "/?smart_dashboard=cinematic"

HASH_SIZE = 8
PHASH_BITS = HASH_SIZE * HASH_SIZE
MAX_HASH_SAMPLES = 8
MIN_HASH_SAMPLES = 3
DUPLICATE_CONFIDENCE_THRESHOLD = 0.90
RECENT_WATCH_DAYS = 90
FORGOTTEN_DAYS = 180
REQUIRED_DEPENDENCIES: Sequence[Tuple[str, str]] = (
    ("requests", "requests"),
    ("cv2", "opencv-python"),
    ("numpy", "numpy"),
    ("imagehash", "imagehash"),
)


class SmartDashboardError(Exception):
    """Base exception for user-facing plugin errors."""


class DependencyError(SmartDashboardError):
    """Raised when an optional runtime dependency is missing."""


class GraphQLClientError(SmartDashboardError):
    """Raised when Stash GraphQL communication fails."""


@dataclass
class SceneFile:
    path: str
    size: Optional[int] = None
    mod_time: Optional[float] = None
    duration: Optional[float] = None


@dataclass
class SceneHash:
    scene_id: str
    title: str
    path: str
    duration: Optional[float]
    hash_chain: List[str]


def log(message: str) -> None:
    print(f"[{PLUGIN_NAME}] {message}", file=sys.stderr, flush=True)


def ensure_runtime_dependencies() -> None:
    try:
        import requests  # type: ignore # noqa: F401
        import cv2  # type: ignore # noqa: F401
        import numpy  # type: ignore # noqa: F401
        import imagehash  # type: ignore # noqa: F401
    except ImportError as exc:
        missing_module = getattr(exc, "name", None) or str(exc)
        matching_package = next(
            (package for module, package in REQUIRED_DEPENDENCIES if module == missing_module),
            missing_module,
        )
        log(
            "Eine benoetigte Python-Abhaengigkeit fehlt "
            f"({matching_package}). Bitte starte zuerst den Task "
            "'Setup / Install Dependencies' in der Stash UI."
        )
        sys.exit(1)


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def write_json_file(path: Path, payload: Dict[str, Any]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")
    tmp_path.replace(path)


def run_setup_dependencies() -> Dict[str, Any]:
    if not REQUIREMENTS_FILE.exists():
        raise SmartDashboardError(f"requirements.txt nicht gefunden: {REQUIREMENTS_FILE}")

    command = [sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)]
    log("Starte Installation der Python-Abhaengigkeiten.")
    log("Befehl: " + " ".join(command))

    process = subprocess.Popen(
        command,
        cwd=str(PLUGIN_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    if process.stdout is not None:
        for line in process.stdout:
            print(line.rstrip(), file=sys.stderr, flush=True)

    exit_code = process.wait()
    if exit_code != 0:
        raise SmartDashboardError(f"Dependency-Installation fehlgeschlagen (Exit-Code {exit_code}).")

    log("Python-Abhaengigkeiten erfolgreich installiert.")
    return {
        "message": "Setup abgeschlossen: Python-Abhaengigkeiten wurden installiert.",
        "requirements_path": str(REQUIREMENTS_FILE),
    }


def run_open_dashboard(payload: Dict[str, Any]) -> Dict[str, Any]:
    stash_base_url = stash_base_url_from_graphql_url(get_graphql_url(payload))
    dashboard_url = f"{stash_base_url.rstrip('/')}{DASHBOARD_DEEP_LINK}"
    return {
        "message": (
            f"Dashboard: {dashboard_url} | "
            "Falls noch keine Daten angezeigt werden, starte zuerst 'Update Dashboard Recommendations'."
        ),
        "dashboard_url": dashboard_url,
    }


def read_stash_payload() -> Dict[str, Any]:
    if sys.stdin is None or sys.stdin.isatty():
        return {}

    try:
        raw = sys.stdin.read()
    except Exception:
        return {}

    raw = raw.strip()
    if not raw:
        return {}

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        log("Stdin enthielt kein gueltiges JSON; fahre mit CLI-/ENV-Argumenten fort.")
        return {}

    return payload if isinstance(payload, dict) else {}


def first_present(mapping: Dict[str, Any], keys: Sequence[str]) -> Optional[Any]:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def deep_find(value: Any, keys: Sequence[str]) -> Optional[Any]:
    """Case-insensitive recursive lookup for Stash payload variants."""
    if isinstance(value, dict):
        lower_to_value = {str(k).lower(): v for k, v in value.items()}
        for key in keys:
            found = lower_to_value.get(key.lower())
            if found not in (None, ""):
                return found
        for child in value.values():
            found = deep_find(child, keys)
            if found not in (None, ""):
                return found
    elif isinstance(value, list):
        for child in value:
            found = deep_find(child, keys)
            if found not in (None, ""):
                return found
    return None


def normalize_client_host(host: Any) -> str:
    text = str(host).strip() if host not in (None, "") else "localhost"
    return "localhost" if text == "0.0.0.0" else text


def normalize_client_url(url: str) -> str:
    return url.replace("://0.0.0.0", "://localhost")


def detect_task(argv: Sequence[str], payload: Dict[str, Any]) -> Optional[str]:
    known_tasks = {"setup", "smart_dup_scan", "smart_dash_calc", "open_dashboard", "cleanup_short"}

    for arg in argv:
        cleaned = arg.strip()
        if cleaned in known_tasks:
            return cleaned
        for task in known_tasks:
            if task in cleaned:
                return task

    env_task = os.environ.get("STASH_TASK_ID") or os.environ.get("STASH_PLUGIN_TASK")
    if env_task in known_tasks:
        return env_task

    args = get_args_payload(payload)
    if first_present(args, ["max_duration_seconds", "maxDurationSeconds", "duration", "seconds", "threshold"]):
        return "cleanup_short"

    candidates = [
        deep_find(payload, ["hookContext", "hook_context"]),
        deep_find(payload, ["id", "hook", "hook_id", "hookID", "task", "mode", "action", "task_id", "taskID", "name"]),
    ]
    for candidate in candidates:
        if isinstance(candidate, dict):
            nested = deep_find(candidate, ["id", "hook", "task", "name"])
            if isinstance(nested, str):
                candidate = nested
        if isinstance(candidate, str):
            for task in known_tasks:
                if candidate == task or task in candidate:
                    return task

    return None


def get_graphql_url(payload: Dict[str, Any]) -> str:
    explicit = (
        os.environ.get("STASH_GRAPHQL_URL")
        or os.environ.get("STASH_GRAPHQL_ENDPOINT")
        or deep_find(payload, ["graphql_url", "graphqlUrl", "endpoint"])
    )
    if isinstance(explicit, str) and explicit.strip():
        return normalize_client_url(explicit.strip())

    base_url = os.environ.get("STASH_URL") or deep_find(payload, ["url", "stash_url", "stashUrl"])
    if isinstance(base_url, str) and base_url.strip():
        base_url = base_url.strip().rstrip("/")
        graphql_url = base_url if base_url.endswith("/graphql") else f"{base_url}/graphql"
        return normalize_client_url(graphql_url)

    server_connection = deep_find(payload, ["server_connection", "serverConnection"])
    if isinstance(server_connection, dict):
        scheme = first_present(server_connection, ["Scheme", "scheme"]) or "http"
        host = normalize_client_host(first_present(server_connection, ["Host", "host"]))
        port = first_present(server_connection, ["Port", "port"]) or 9999
        return f"{scheme}://{host}:{port}/graphql"

    return DEFAULT_STASH_GRAPHQL_URL


def get_api_key(payload: Dict[str, Any]) -> Optional[str]:
    value = (
        os.environ.get("STASH_API_KEY")
        or os.environ.get("STASH_APIKEY")
        or os.environ.get("STASH_API_TOKEN")
        or deep_find(payload, ["api_key", "apiKey", "apikey", "api_token", "apiToken"])
    )
    return str(value).strip() if value not in (None, "") else None


def get_session_cookie(payload: Dict[str, Any]) -> Optional[str]:
    cookie = deep_find(payload, ["SessionCookie", "sessionCookie"])
    if isinstance(cookie, dict):
        name = first_present(cookie, ["Name", "name"])
        value = first_present(cookie, ["Value", "value"])
        if name and value:
            return f"{name}={value}"
    if isinstance(cookie, str) and cookie.strip():
        return cookie.strip()
    return None


class GraphQLClient:
    def __init__(self, url: str, api_key: Optional[str] = None, cookie: Optional[str] = None) -> None:
        try:
            import requests  # type: ignore
        except ImportError as exc:
            raise DependencyError(
                "Das Python-Paket 'requests' fehlt. Installiere es z.B. mit: "
                "python -m pip install requests"
            ) from exc

        self._requests = requests
        self.url = url
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["ApiKey"] = api_key
            self.headers["Authorization"] = f"Bearer {api_key}"
        if cookie:
            self.headers["Cookie"] = cookie

    def execute(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body = {"query": query, "variables": variables or {}}
        try:
            response = self._requests.post(self.url, json=body, headers=self.headers, timeout=60)
            response.raise_for_status()
        except self._requests.exceptions.RequestException as exc:
            raise GraphQLClientError(f"GraphQL-Verbindung zu {self.url} fehlgeschlagen: {exc}") from exc

        try:
            payload = response.json()
        except ValueError as exc:
            raise GraphQLClientError("Stash GraphQL lieferte keine gueltige JSON-Antwort.") from exc

        if payload.get("errors"):
            messages = "; ".join(str(error.get("message", error)) for error in payload["errors"])
            raise GraphQLClientError(messages)

        data = payload.get("data")
        if not isinstance(data, dict):
            raise GraphQLClientError("Stash GraphQL Antwort enthielt kein 'data'-Objekt.")

        return data


DUP_QUERY_VARIANTS: Sequence[Tuple[str, str]] = (
    (
        "files_with_metadata",
        """
        query SmartDashboardDuplicateScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              files { path size mod_time duration }
            }
          }
        }
        """,
    ),
    (
        "files_path_only",
        """
        query SmartDashboardDuplicateScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              files { path }
            }
          }
        }
        """,
    ),
    (
        "legacy_file",
        """
        query SmartDashboardDuplicateScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              file { path size mod_time duration }
            }
          }
        }
        """,
    ),
)

CLEANUP_QUERY_VARIANTS: Sequence[Tuple[str, str]] = (
    (
        "files_with_duration",
        """
        query SmartDashboardCleanupScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              files { path duration }
            }
          }
        }
        """,
    ),
    (
        "legacy_file_duration",
        """
        query SmartDashboardCleanupScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              file { path duration }
            }
          }
        }
        """,
    ),
)

DASH_QUERY_VARIANTS: Sequence[Tuple[str, str]] = (
    (
        "rating100_ui_full",
        """
        query SmartDashboardRecommendationScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              rating100
              play_count
              resume_time
              last_played_at
              paths { screenshot }
              files { path duration width height }
              tags { id name }
              performers { id name }
              studio { id name }
            }
          }
        }
        """,
    ),
    (
        "rating_ui_full",
        """
        query SmartDashboardRecommendationScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              rating
              play_count
              resume_time
              last_played_at
              paths { screenshot }
              files { path duration width height }
              tags { id name }
              performers { id name }
              studio { id name }
            }
          }
        }
        """,
    ),
    (
        "rating100_full",
        """
        query SmartDashboardRecommendationScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              rating100
              play_count
              resume_time
              last_played_at
              tags { id name }
              performers { id name }
              studio { id name }
            }
          }
        }
        """,
    ),
    (
        "rating_full",
        """
        query SmartDashboardRecommendationScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              rating
              play_count
              resume_time
              last_played_at
              tags { id name }
              performers { id name }
              studio { id name }
            }
          }
        }
        """,
    ),
    (
        "rating100_no_last_played",
        """
        query SmartDashboardRecommendationScenes($filter: FindFilterType!) {
          findScenes(filter: $filter) {
            count
            scenes {
              id
              title
              rating100
              play_count
              resume_time
              tags { id name }
              performers { id name }
              studio { id name }
            }
          }
        }
        """,
    ),
)


def fetch_scenes(client: GraphQLClient, query: str, per_page: int = 250) -> List[Dict[str, Any]]:
    scenes: List[Dict[str, Any]] = []
    page = 1

    while True:
        data = client.execute(query, {"filter": {"page": page, "per_page": per_page}})
        container = data.get("findScenes")
        if not isinstance(container, dict):
            raise GraphQLClientError("GraphQL Antwort enthielt kein findScenes-Objekt.")

        page_scenes = container.get("scenes") or []
        if not isinstance(page_scenes, list):
            raise GraphQLClientError("GraphQL Antwort enthielt keine gueltige scenes-Liste.")

        scenes.extend(scene for scene in page_scenes if isinstance(scene, dict))
        count = container.get("count")
        if not page_scenes or (isinstance(count, int) and len(scenes) >= count) or len(page_scenes) < per_page:
            break

        page += 1

    return scenes


def fetch_scenes_with_variants(
    client: GraphQLClient,
    variants: Sequence[Tuple[str, str]],
    per_page: int = 250,
) -> Tuple[List[Dict[str, Any]], str]:
    last_error: Optional[Exception] = None
    for name, query in variants:
        try:
            scenes = fetch_scenes(client, query, per_page=per_page)
            log(f"GraphQL Query-Variante '{name}' erfolgreich: {len(scenes)} Szenen geladen.")
            return scenes, name
        except GraphQLClientError as exc:
            last_error = exc
            log(f"GraphQL Query-Variante '{name}' nicht nutzbar: {exc}")

    raise GraphQLClientError(f"Keine kompatible GraphQL Query gefunden. Letzter Fehler: {last_error}")


def safe_int(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_duration_seconds(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None

    text = str(value).strip()
    if not text:
        return None

    if ":" not in text:
        return safe_float(text)

    parts = text.split(":")
    if len(parts) not in (2, 3):
        return None

    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return None

    if any(part < 0 for part in numbers):
        return None

    if len(numbers) == 2:
        minutes, seconds = numbers
        return minutes * 60 + seconds

    hours, minutes, seconds = numbers
    return hours * 3600 + minutes * 60 + seconds


def get_args_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    args = payload.get("args")
    return args if isinstance(args, dict) else {}


def get_cleanup_max_duration(argv: Sequence[str], payload: Dict[str, Any]) -> float:
    raw_value: Optional[Any] = None
    if len(argv) >= 2:
        raw_value = argv[1]

    args = get_args_payload(payload)
    if raw_value in (None, ""):
        raw_value = first_present(
            args,
            [
                "max_duration_seconds",
                "maxDurationSeconds",
                "duration",
                "seconds",
                "threshold",
            ],
        )

    max_duration = parse_duration_seconds(raw_value)
    if max_duration is None or max_duration <= 0:
        raise SmartDashboardError(
            "cleanup_short benoetigt eine gueltige Dauer groesser 0 Sekunden. "
            "Nutze das Dashboard-Feld 'Videos kuerzer als (Minuten:Sekunden) loeschen'."
        )

    return max_duration


def parse_scene_file(scene: Dict[str, Any]) -> Optional[SceneFile]:
    files = scene.get("files")
    file_obj: Optional[Dict[str, Any]] = None

    if isinstance(files, list) and files:
        first_file = files[0]
        if isinstance(first_file, dict):
            file_obj = first_file
    elif isinstance(scene.get("file"), dict):
        file_obj = scene["file"]

    if file_obj:
        path = file_obj.get("path")
        if isinstance(path, str) and path.strip():
            return SceneFile(
                path=path,
                size=safe_int(file_obj.get("size")),
                mod_time=safe_float(file_obj.get("mod_time")),
                duration=safe_float(file_obj.get("duration")),
            )

    path = scene.get("path")
    if isinstance(path, str) and path.strip():
        return SceneFile(path=path, duration=safe_float(scene.get("duration")))

    return None


def init_cache() -> sqlite3.Connection:
    conn = sqlite3.connect(str(CACHE_DB))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS video_hashes (
          scene_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          file_mtime REAL,
          file_size INTEGER,
          duration REAL,
          hash_chain TEXT NOT NULL,
          sample_count INTEGER NOT NULL,
          scanned_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def file_signature(scene_file: SceneFile) -> Tuple[Optional[float], Optional[int]]:
    path = Path(scene_file.path)
    try:
        stat = path.stat()
        return stat.st_mtime, stat.st_size
    except OSError:
        return scene_file.mod_time, scene_file.size


def nearly_equal(left: Optional[float], right: Optional[float], tolerance: float = 1.0) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return abs(left - right) <= tolerance


def get_cached_hash(
    conn: sqlite3.Connection,
    scene_id: str,
    path: str,
    mtime: Optional[float],
    size: Optional[int],
) -> Optional[List[str]]:
    row = conn.execute(
        "SELECT path, file_mtime, file_size, hash_chain FROM video_hashes WHERE scene_id = ?",
        (scene_id,),
    ).fetchone()
    if not row:
        return None

    cached_path, cached_mtime, cached_size, hash_chain_json = row
    if cached_path != path:
        return None
    if cached_size != size:
        return None
    if not nearly_equal(cached_mtime, mtime):
        return None

    try:
        hash_chain = json.loads(hash_chain_json)
    except json.JSONDecodeError:
        return None

    return hash_chain if isinstance(hash_chain, list) and hash_chain else None


def store_hash(
    conn: sqlite3.Connection,
    scene_hash: SceneHash,
    mtime: Optional[float],
    size: Optional[int],
) -> None:
    conn.execute(
        """
        REPLACE INTO video_hashes
          (scene_id, path, file_mtime, file_size, duration, hash_chain, sample_count, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            scene_hash.scene_id,
            scene_hash.path,
            mtime,
            size,
            scene_hash.duration,
            json.dumps(scene_hash.hash_chain),
            len(scene_hash.hash_chain),
            iso_now(),
        ),
    )
    conn.commit()


def ensure_video_dependencies() -> Tuple[Any, Any]:
    missing: List[str] = []
    try:
        import cv2  # type: ignore
    except ImportError:
        cv2 = None
        missing.append("opencv-python")

    try:
        import numpy as np  # type: ignore
    except ImportError:
        np = None
        missing.append("numpy")

    if missing:
        packages = " ".join(missing)
        raise DependencyError(
            "Fuer die erweiterte Duplikatsuche fehlen Python-Pakete: "
            f"{', '.join(missing)}. Installiere sie z.B. mit: python -m pip install {packages}"
        )

    return cv2, np


def sample_timestamps(duration: Optional[float]) -> List[float]:
    if not duration or duration <= 0:
        return []

    if duration < 10:
        sample_count = 1
    elif duration < 60:
        sample_count = MIN_HASH_SAMPLES
    elif duration < 30 * 60:
        sample_count = 5
    else:
        sample_count = MAX_HASH_SAMPLES

    return [duration * ((index + 1) / (sample_count + 1)) for index in range(sample_count)]


def phash_frame(frame: Any, cv2: Any, np: Any) -> str:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
    resized = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
    dct = cv2.dct(np.float32(resized))
    low_frequency = dct[:HASH_SIZE, :HASH_SIZE].flatten()
    median = np.median(low_frequency[1:]) if len(low_frequency) > 1 else np.median(low_frequency)

    value = 0
    for coefficient in low_frequency:
        value = (value << 1) | int(coefficient > median)
    return f"{value:016x}"


def compute_video_hash_chain(scene_file: SceneFile, cv2: Any, np: Any) -> Tuple[List[str], Optional[float]]:
    capture = cv2.VideoCapture(scene_file.path)
    if not capture.isOpened():
        raise SmartDashboardError(f"Video konnte nicht geoeffnet werden: {scene_file.path}")

    try:
        fps = safe_float(capture.get(cv2.CAP_PROP_FPS)) or 0.0
        frame_count = safe_float(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 0.0
        duration = scene_file.duration
        if not duration and fps > 0 and frame_count > 0:
            duration = frame_count / fps

        timestamps = sample_timestamps(duration)
        frame_positions: List[int] = []
        if not timestamps and frame_count > 0:
            sample_count = min(MAX_HASH_SAMPLES, max(1, int(frame_count)))
            frame_positions = [
                int(frame_count * ((index + 1) / (sample_count + 1))) for index in range(sample_count)
            ]

        hashes: List[str] = []
        for timestamp in timestamps:
            capture.set(cv2.CAP_PROP_POS_MSEC, max(0, timestamp * 1000))
            ok, frame = capture.read()
            if ok and frame is not None:
                hashes.append(phash_frame(frame, cv2, np))

        for frame_position in frame_positions:
            capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_position))
            ok, frame = capture.read()
            if ok and frame is not None:
                hashes.append(phash_frame(frame, cv2, np))

        if not hashes:
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = capture.read()
            if ok and frame is not None:
                hashes.append(phash_frame(frame, cv2, np))

        if not hashes:
            raise SmartDashboardError(f"Keine Frames lesbar: {scene_file.path}")

        return hashes, duration
    finally:
        capture.release()


def hamming_distance_hex(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def compare_hash_chains(left: Sequence[str], right: Sequence[str]) -> Tuple[float, float, int]:
    comparisons = min(len(left), len(right))
    if comparisons == 0:
        return 0.0, float(PHASH_BITS), 0

    distances = [hamming_distance_hex(left[index], right[index]) for index in range(comparisons)]
    average_distance = sum(distances) / comparisons
    confidence = max(0.0, 1.0 - (average_distance / PHASH_BITS))
    return confidence, average_distance, comparisons


def run_duplicate_scan(client: GraphQLClient) -> Dict[str, Any]:
    cv2, np = ensure_video_dependencies()
    scenes, query_variant = fetch_scenes_with_variants(client, DUP_QUERY_VARIANTS)
    conn = init_cache()

    hashed_scenes: List[SceneHash] = []
    skipped: List[Dict[str, str]] = []
    cache_hits = 0
    rescanned = 0

    try:
        for index, scene in enumerate(scenes, start=1):
            scene_id = str(scene.get("id", "")).strip()
            title = str(scene.get("title") or scene_id or "Untitled")
            scene_file = parse_scene_file(scene)
            if not scene_id or not scene_file:
                skipped.append({"scene_id": scene_id or "unknown", "reason": "Keine Datei/Pfad in GraphQL-Antwort"})
                continue

            if not Path(scene_file.path).exists():
                skipped.append({"scene_id": scene_id, "path": scene_file.path, "reason": "Datei existiert nicht"})
                continue

            mtime, size = file_signature(scene_file)
            cached_hash = get_cached_hash(conn, scene_id, scene_file.path, mtime, size)
            if cached_hash:
                cache_hits += 1
                hashed_scenes.append(
                    SceneHash(scene_id=scene_id, title=title, path=scene_file.path, duration=scene_file.duration, hash_chain=cached_hash)
                )
            else:
                try:
                    hash_chain, duration = compute_video_hash_chain(scene_file, cv2, np)
                    scene_hash = SceneHash(
                        scene_id=scene_id,
                        title=title,
                        path=scene_file.path,
                        duration=duration,
                        hash_chain=hash_chain,
                    )
                    store_hash(conn, scene_hash, mtime, size)
                    hashed_scenes.append(scene_hash)
                    rescanned += 1
                except Exception as exc:
                    skipped.append({"scene_id": scene_id, "path": scene_file.path, "reason": str(exc)})

            if index % 25 == 0:
                log(f"Duplikatscan Fortschritt: {index}/{len(scenes)} Szenen verarbeitet.")
    finally:
        conn.close()

    duplicates: List[Dict[str, Any]] = []
    for left_index in range(len(hashed_scenes)):
        left = hashed_scenes[left_index]
        for right in hashed_scenes[left_index + 1 :]:
            confidence, average_distance, compared_samples = compare_hash_chains(left.hash_chain, right.hash_chain)
            if confidence >= DUPLICATE_CONFIDENCE_THRESHOLD:
                duplicate = {
                    "confidence": round(confidence, 4),
                    "average_hamming_distance": round(average_distance, 2),
                    "compared_samples": compared_samples,
                    "scene_a": {"id": left.scene_id, "title": left.title, "path": left.path},
                    "scene_b": {"id": right.scene_id, "title": right.title, "path": right.path},
                }
                duplicates.append(duplicate)
                log(
                    "Moegliches Duplikat gefunden: "
                    f"{left.scene_id} <-> {right.scene_id} ({confidence:.1%})"
                )

    duplicates.sort(key=lambda item: item["confidence"], reverse=True)
    report = {
        "plugin": PLUGIN_NAME,
        "author": AUTHOR,
        "generated_at": iso_now(),
        "graphql_query_variant": query_variant,
        "threshold": DUPLICATE_CONFIDENCE_THRESHOLD,
        "total_scenes": len(scenes),
        "hashed_scenes": len(hashed_scenes),
        "cache_hits": cache_hits,
        "rescanned": rescanned,
        "skipped": skipped,
        "duplicates": duplicates,
    }
    write_json_file(DUPLICATES_REPORT, report)

    return {
        "message": (
            f"Duplikatscan abgeschlossen: {len(duplicates)} Kandidaten gefunden, "
            f"{len(hashed_scenes)} Szenen gehasht, {cache_hits} Cache-Treffer."
        ),
        "report_path": str(DUPLICATES_REPORT),
        "duplicates": len(duplicates),
        "hashed_scenes": len(hashed_scenes),
        "skipped": len(skipped),
    }


def destroy_scene_record_only(client: GraphQLClient, scene_id: str) -> bool:
    full_mutation = """
    mutation SmartDashboardDestroyScene($input: SceneDestroyInput!) {
      sceneDestroy(input: $input)
    }
    """
    input_payload = {
        "id": scene_id,
        "delete_file": False,
        "delete_generated": True,
        "destroy_file_entry": False,
    }

    try:
        data = client.execute(full_mutation, {"input": input_payload})
    except GraphQLClientError as exc:
        if "destroy_file_entry" not in str(exc):
            raise
        legacy_input = {
            "id": scene_id,
            "delete_file": False,
            "delete_generated": True,
        }
        data = client.execute(full_mutation, {"input": legacy_input})

    return bool(data.get("sceneDestroy"))


def video_duration_from_file(path: Optional[str]) -> Optional[float]:
    if not path or not Path(path).exists():
        return None

    try:
        cv2, _np = ensure_video_dependencies()
    except SmartDashboardError as exc:
        log(f"Kann Dauer nicht aus Datei lesen, Video-Abhaengigkeit fehlt: {exc}")
        return None

    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        return None

    try:
        fps = safe_float(capture.get(cv2.CAP_PROP_FPS)) or 0.0
        frame_count = safe_float(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 0.0
        if fps > 0 and frame_count > 0:
            return frame_count / fps
        return None
    finally:
        capture.release()


def remove_deleted_scenes_from_recommendations(deleted_scene_ids: Sequence[str]) -> int:
    if not deleted_scene_ids or not RECOMMENDATIONS_REPORT.exists():
        return 0

    deleted = set(str(scene_id) for scene_id in deleted_scene_ids)
    try:
        with RECOMMENDATIONS_REPORT.open("r", encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        log(f"recommendations.json konnte nach Cleanup nicht bereinigt werden: {exc}")
        return 0

    if not isinstance(report, dict):
        return 0

    removed = 0
    for key in ("forgotten_gems", "smart_suggestions", "top_rated", "recently_watched", "library_spotlight"):
        items = report.get(key)
        if not isinstance(items, list):
            continue
        kept = [item for item in items if not (isinstance(item, dict) and str(item.get("id")) in deleted)]
        removed += len(items) - len(kept)
        report[key] = kept

    if removed:
        report["generated_at"] = iso_now()
        report["cleanup_note"] = {
            "removed_deleted_scene_ids": sorted(deleted),
            "updated_at": iso_now(),
        }
        write_json_file(RECOMMENDATIONS_REPORT, report)
        log(f"recommendations.json bereinigt: {removed} Eintraege entfernt.")

    return removed


def run_cleanup_short(client: GraphQLClient, max_duration_seconds: float) -> Dict[str, Any]:
    scenes, query_variant = fetch_scenes_with_variants(client, CLEANUP_QUERY_VARIANTS)
    candidates: List[Tuple[str, str, Optional[str], float]] = []
    missing_duration = 0
    file_duration_fallbacks = 0

    for scene in scenes:
        scene_id = str(scene.get("id", "")).strip()
        title = str(scene.get("title") or scene_id or "Untitled")
        scene_file = parse_scene_file(scene)
        duration = safe_float(scene_file.duration if scene_file else scene.get("duration"))
        if duration is None and scene_file:
            duration = video_duration_from_file(scene_file.path)
            if duration is not None:
                file_duration_fallbacks += 1
        if not scene_id or duration is None:
            missing_duration += 1
            continue
        if duration < max_duration_seconds:
            candidates.append((scene_id, title, scene_file.path if scene_file else None, duration))

    log(
        "Short-Video-Cleanup: "
        f"{len(candidates)} Szenen unter {max_duration_seconds:g}s gefunden "
        f"(Query-Variante: {query_variant}, "
        f"{file_duration_fallbacks} Datei-Dauer-Fallbacks, "
        f"{missing_duration} ohne Dauer)."
    )

    deleted = 0
    deleted_scene_ids: List[str] = []
    failed: List[Dict[str, str]] = []
    for scene_id, title, path, duration in candidates:
        log(f"Entferne kurze Szene aus Stash: {scene_id} | {duration:.2f}s | {title} | {path or 'kein Pfad'}")
        try:
            if destroy_scene_record_only(client, scene_id):
                deleted += 1
                deleted_scene_ids.append(scene_id)
            else:
                failed.append({"scene_id": scene_id, "title": title, "reason": "sceneDestroy gab false zurueck"})
        except Exception as exc:
            failed.append({"scene_id": scene_id, "title": title, "reason": str(exc)})
            log(f"Fehler beim Loeschen von Szene {scene_id}: {exc}")

    removed_recommendation_items = remove_deleted_scenes_from_recommendations(deleted_scene_ids)

    return {
        "message": (
            f"Short-Video-Cleanup abgeschlossen: {deleted}/{len(candidates)} Szenen "
            f"unter {max_duration_seconds:g}s aus Stash entfernt. Dateien wurden nicht geloescht."
        ),
        "max_duration_seconds": max_duration_seconds,
        "matched_scenes": len(candidates),
        "deleted_scenes": deleted,
        "file_duration_fallbacks": file_duration_fallbacks,
        "missing_duration": missing_duration,
        "removed_recommendation_items": removed_recommendation_items,
        "failed_scenes": failed,
    }


def parse_datetime(value: Any) -> Optional[dt.datetime]:
    if value in (None, ""):
        return None

    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(float(value), tz=dt.timezone.utc)
        except (OSError, ValueError):
            return None

    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        try:
            parsed_date = dt.datetime.strptime(text[:10], "%Y-%m-%d")
            parsed = parsed_date.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def days_since(value: Any) -> Optional[int]:
    parsed = parse_datetime(value)
    if not parsed:
        return None
    return max(0, (utc_now() - parsed).days)


def normalize_rating(scene: Dict[str, Any]) -> Optional[float]:
    rating100 = safe_float(scene.get("rating100"))
    if rating100 is not None:
        return round(max(0.0, min(5.0, rating100 / 20.0)), 2)

    rating = safe_float(scene.get("rating"))
    if rating is None:
        return None
    if rating > 10:
        return round(max(0.0, min(5.0, rating / 20.0)), 2)
    if rating > 5:
        return round(max(0.0, min(5.0, rating / 2.0)), 2)
    return round(max(0.0, min(5.0, rating)), 2)


def entity_names(items: Any) -> List[str]:
    if not isinstance(items, list):
        return []
    names: List[str] = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            names.append(item["name"])
    return names


def studio_name(scene: Dict[str, Any]) -> Optional[str]:
    studio = scene.get("studio")
    if isinstance(studio, dict) and isinstance(studio.get("name"), str):
        return studio["name"]
    studios = scene.get("studios")
    if isinstance(studios, list) and studios:
        first = studios[0]
        if isinstance(first, dict) and isinstance(first.get("name"), str):
            return first["name"]
    return None


def play_count(scene: Dict[str, Any]) -> int:
    return safe_int(scene.get("play_count")) or 0


def stash_base_url_from_graphql_url(graphql_url: str) -> str:
    cleaned = graphql_url.strip().rstrip("/")
    if cleaned.endswith("/graphql"):
        return cleaned[: -len("/graphql")]
    return cleaned or "http://localhost:9999"


def absolute_stash_asset_url(value: Optional[str], stash_base_url: str) -> Optional[str]:
    if not value:
        return None

    text = value.strip()
    if not text:
        return None
    if text.startswith(("http://", "https://", "file://", "data:")):
        return text
    if text.startswith("/"):
        return f"{stash_base_url.rstrip('/')}{text}"
    return f"{stash_base_url.rstrip('/')}/{text.lstrip('/')}"


def scene_cover_path(scene: Dict[str, Any], stash_base_url: str) -> Optional[str]:
    paths = scene.get("paths")
    if isinstance(paths, dict):
        value = paths.get("screenshot")
        if isinstance(value, str):
            return absolute_stash_asset_url(value, stash_base_url)
    return None


def scene_resolution(scene: Dict[str, Any]) -> Optional[str]:
    file_candidates: List[Any] = []
    files = scene.get("files")
    if isinstance(files, list):
        file_candidates.extend(files)
    if isinstance(scene.get("file"), dict):
        file_candidates.append(scene["file"])
    file_candidates.append(scene)

    for file_obj in file_candidates:
        if not isinstance(file_obj, dict):
            continue
        width = safe_int(file_obj.get("width"))
        height = safe_int(file_obj.get("height"))
        if width and height:
            return f"{width}x{height}"
    return None


def scene_primary_file_path(scene: Dict[str, Any]) -> Optional[str]:
    scene_file = parse_scene_file(scene)
    return scene_file.path if scene_file else None


def scene_file_name(scene: Dict[str, Any]) -> Optional[str]:
    path = scene_primary_file_path(scene)
    if not path:
        return None
    return Path(path).name


def scene_display_title(scene: Dict[str, Any]) -> str:
    title = scene.get("title")
    if isinstance(title, str) and title.strip() and title.strip().lower() != "untitled":
        return title.strip()

    file_name = scene_file_name(scene)
    if file_name:
        return Path(file_name).stem or file_name

    scene_id = str(scene.get("id", "")).strip()
    return f"Scene {scene_id}" if scene_id else "Untitled"


def recommendation_item(
    scene: Dict[str, Any],
    score: float,
    reason: str,
    stash_base_url: str,
) -> Dict[str, Any]:
    scene_id = str(scene.get("id"))
    cover_path = scene_cover_path(scene, stash_base_url)
    file_path = scene_primary_file_path(scene)
    return {
        "id": scene_id,
        "title": scene_display_title(scene),
        "stash_title": scene.get("title"),
        "file_name": Path(file_path).name if file_path else None,
        "file_path": file_path,
        "cover_path": cover_path,
        "thumbnail": cover_path,
        "rating": normalize_rating(scene),
        "resolution": scene_resolution(scene),
        "score": round(score, 4),
        "reason": reason,
        "play_count": play_count(scene),
        "resume_time": safe_float(scene.get("resume_time")) or 0,
        "last_played_at": scene.get("last_played_at"),
        "days_since_last_played": days_since(scene.get("last_played_at")),
        "tags": entity_names(scene.get("tags")),
        "performers": entity_names(scene.get("performers")),
        "studio": studio_name(scene),
        "stash_url": f"{stash_base_url.rstrip('/')}/scenes/{scene_id}",
    }


def build_preference_counters(scenes: Sequence[Dict[str, Any]]) -> Tuple[Counter, Counter]:
    tag_scores: Counter = Counter()
    studio_scores: Counter = Counter()

    for scene in scenes:
        count = play_count(scene)
        last_days = days_since(scene.get("last_played_at"))
        rating = normalize_rating(scene) or 0.0
        has_history = count > 0 or last_days is not None
        if not has_history:
            continue

        recency_bonus = 0.0 if last_days is None else max(0.0, 1.0 - min(last_days, 365) / 365.0)
        weight = 1.0 + min(count, 10) * 0.6 + (rating / 5.0) + recency_bonus

        for tag in entity_names(scene.get("tags")):
            tag_scores[tag] += weight
        studio = studio_name(scene)
        if studio:
            studio_scores[studio] += weight

    if not tag_scores and not studio_scores:
        for scene in scenes:
            rating = normalize_rating(scene) or 0.0
            if rating < 4.0:
                continue
            for tag in entity_names(scene.get("tags")):
                tag_scores[tag] += rating
            studio = studio_name(scene)
            if studio:
                studio_scores[studio] += rating

    return tag_scores, studio_scores


def run_dashboard_calc(client: GraphQLClient) -> Dict[str, Any]:
    scenes, query_variant = fetch_scenes_with_variants(client, DASH_QUERY_VARIANTS)
    stash_base_url = stash_base_url_from_graphql_url(client.url)
    tag_scores, studio_scores = build_preference_counters(scenes)

    forgotten_gems: List[Dict[str, Any]] = []
    for scene in scenes:
        rating = normalize_rating(scene)
        last_days = days_since(scene.get("last_played_at"))
        if rating is not None and rating >= 4.0 and last_days is not None and last_days > FORGOTTEN_DAYS:
            score = rating + min(last_days / 365.0, 3.0) + min(play_count(scene), 10) * 0.05
            forgotten_gems.append(
                recommendation_item(
                    scene,
                    score,
                    f"Rating {rating}/5 und seit {last_days} Tagen nicht gesehen",
                    stash_base_url,
                )
            )

    forgotten_gems.sort(key=lambda item: item["score"], reverse=True)

    max_tag_score = max(tag_scores.values(), default=1.0)
    max_studio_score = max(studio_scores.values(), default=1.0)
    smart_suggestions: List[Dict[str, Any]] = []

    for scene in scenes:
        rating = normalize_rating(scene) or 0.0
        last_days = days_since(scene.get("last_played_at"))
        if rating < 3.5:
            continue
        if last_days is not None and last_days < RECENT_WATCH_DAYS:
            continue

        matched_tags = [tag for tag in entity_names(scene.get("tags")) if tag_scores.get(tag, 0) > 0]
        matched_studio = studio_name(scene) if studio_scores.get(studio_name(scene) or "", 0) > 0 else None

        tag_score = sum(tag_scores.get(tag, 0.0) for tag in matched_tags) / max_tag_score
        studio_score = (studio_scores.get(matched_studio, 0.0) / max_studio_score) if matched_studio else 0.0
        unplayed_bonus = 0.5 if play_count(scene) == 0 and last_days is None else 0.0
        final_score = (rating / 5.0) * 2.0 + tag_score + studio_score + unplayed_bonus

        if final_score <= 1.5:
            continue

        reasons: List[str] = []
        if matched_tags:
            reasons.append("Tags: " + ", ".join(matched_tags[:5]))
        if matched_studio:
            reasons.append("Studio: " + matched_studio)
        if unplayed_bonus:
            reasons.append("noch nicht angesehen")
        reason = "; ".join(reasons) if reasons else f"Hohe Bewertung ({rating}/5)"
        smart_suggestions.append(recommendation_item(scene, final_score, reason, stash_base_url))

    smart_suggestions.sort(key=lambda item: item["score"], reverse=True)

    top_rated: List[Dict[str, Any]] = []
    for scene in scenes:
        rating = normalize_rating(scene)
        if rating is None:
            continue
        score = rating + min(play_count(scene), 25) * 0.02
        top_rated.append(recommendation_item(scene, score, f"Top rated: {rating}/5", stash_base_url))
    top_rated.sort(key=lambda item: (item["rating"] or 0, item["score"]), reverse=True)

    recently_watched_scenes = [
        scene for scene in scenes if parse_datetime(scene.get("last_played_at")) is not None
    ]
    recently_watched_scenes.sort(
        key=lambda scene: parse_datetime(scene.get("last_played_at")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc),
        reverse=True,
    )
    recently_watched = [
        recommendation_item(
            scene,
            float(max(0, 365 - (days_since(scene.get("last_played_at")) or 365))),
            "Recently watched",
            stash_base_url,
        )
        for scene in recently_watched_scenes[:50]
    ]

    library_spotlight: List[Dict[str, Any]] = []
    for index, scene in enumerate(scenes):
        rating = normalize_rating(scene) or 0.0
        plays = play_count(scene)
        score = rating + min(plays, 25) * 0.05 + max(0.0, 1.0 - index / max(len(scenes), 1))
        reasons: List[str] = []
        if rating:
            reasons.append(f"Rating {rating}/5")
        if plays:
            reasons.append(f"{plays} plays")
        studio = studio_name(scene)
        if studio:
            reasons.append(studio)
        reason = "; ".join(reasons) if reasons else "Aus deiner Stash-Bibliothek"
        library_spotlight.append(recommendation_item(scene, score, reason, stash_base_url))
    library_spotlight.sort(key=lambda item: item["score"], reverse=True)

    if not top_rated:
        top_rated = library_spotlight[:50]
    if not smart_suggestions:
        smart_suggestions = library_spotlight[:50]

    report = {
        "plugin": PLUGIN_NAME,
        "author": AUTHOR,
        "generated_at": iso_now(),
        "graphql_query_variant": query_variant,
        "stash_base_url": stash_base_url,
        "parameters": {
            "forgotten_days": FORGOTTEN_DAYS,
            "recent_watch_days": RECENT_WATCH_DAYS,
            "minimum_forgotten_rating": 4.0,
            "minimum_suggestion_rating": 3.5,
        },
        "preference_profile": {
            "top_tags": [{"name": name, "score": round(score, 4)} for name, score in tag_scores.most_common(20)],
            "top_studios": [
                {"name": name, "score": round(score, 4)} for name, score in studio_scores.most_common(20)
            ],
        },
        "forgotten_gems": forgotten_gems[:50],
        "smart_suggestions": smart_suggestions[:50],
        "top_rated": top_rated[:50],
        "recently_watched": recently_watched,
        "library_spotlight": library_spotlight[:50],
    }
    write_json_file(RECOMMENDATIONS_REPORT, report)

    return {
        "message": (
            f"Dashboard-Empfehlungen aktualisiert: {len(report['forgotten_gems'])} Forgotten Gems, "
            f"{len(report['smart_suggestions'])} Smart Suggestions."
        ),
        "report_path": str(RECOMMENDATIONS_REPORT),
        "forgotten_gems": len(report["forgotten_gems"]),
        "smart_suggestions": len(report["smart_suggestions"]),
    }


def make_client(payload: Dict[str, Any]) -> GraphQLClient:
    url = get_graphql_url(payload)
    api_key = get_api_key(payload)
    cookie = get_session_cookie(payload)
    log(f"Verbinde mit Stash GraphQL: {url}")
    return GraphQLClient(url=url, api_key=api_key, cookie=cookie)


def success_response(result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "output": result.get("message", "Smart Dashboard Aufgabe abgeschlossen."),
        "result": result,
    }


def error_response(exc: Exception) -> Dict[str, Any]:
    log(str(exc))
    return {
        "output": f"Smart Dashboard Fehler: {exc}",
        "error": str(exc),
    }


def main() -> None:
    payload = read_stash_payload()
    task = detect_task(sys.argv[1:], payload)

    try:
        if not task:
            response = {
                "output": (
                    "Smart Dashboard Plugin bereit. Bekannte Tasks: "
                    "setup, smart_dup_scan, smart_dash_calc, open_dashboard, cleanup_short."
                ),
                "plugin": PLUGIN_NAME,
                "author": AUTHOR,
            }
        elif task == "setup":
            response = success_response(run_setup_dependencies())
        elif task == "open_dashboard":
            response = success_response(run_open_dashboard(payload))
        else:
            ensure_runtime_dependencies()
            client = make_client(payload)
            if task == "smart_dup_scan":
                response = success_response(run_duplicate_scan(client))
            elif task == "smart_dash_calc":
                response = success_response(run_dashboard_calc(client))
            elif task == "cleanup_short":
                max_duration = get_cleanup_max_duration(sys.argv[1:], payload)
                response = success_response(run_cleanup_short(client, max_duration))
            else:
                raise SmartDashboardError(f"Unbekannter Task: {task}")
    except SmartDashboardError as exc:
        response = error_response(exc)
    except Exception as exc:
        log(traceback.format_exc())
        response = error_response(SmartDashboardError(f"Unerwarteter Fehler: {exc}"))

    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()