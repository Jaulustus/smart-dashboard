#!/usr/bin/env python3
"""Backend for the Smart Dashboard & Advanced Duplicate Finder Stash plugin (Cinematic UI, duplicates, recommendations, MCP agent).

Stash invokes raw plugins as a process and expects one JSON object on stdout.
Diagnostics are written to stderr so stdout stays parseable by Stash.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import traceback
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

PLUGIN_DIR = Path(__file__).resolve().parent
VENDOR_DIR = PLUGIN_DIR / "vendor"
SETUP_STATUS_FILE = PLUGIN_DIR / "setup_status.json"
SCAN_PROGRESS_FILE = PLUGIN_DIR / "scan_progress.json"
PLUGIN_LOG_FILE = PLUGIN_DIR / "setup_log.txt"
SETUP_LOG_FILE = PLUGIN_LOG_FILE
MCP_PATHS_HINT_FILE = PLUGIN_DIR / "mcp_paths.json"
AGENT_UI_SNAPSHOT_FILE = PLUGIN_DIR / "agent_ui_snapshot.json"
INSTALL_STATE_FILE = PLUGIN_DIR / "install_state.json"
SETUP_LOG_SNAPSHOT_FILE = PLUGIN_DIR / "setup_log_snapshot.json"
SETUP_LOG_SNAPSHOT_LINES = 250
PLUGIN_VERSION = "0.3.0"
MAX_PLUGIN_LOG_LINES = 800
MAX_SETUP_LOG_LINES = MAX_PLUGIN_LOG_LINES
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))


def ensure_vendor_on_path() -> None:
    """Make plugin-local pip installs (--target vendor/) importable."""
    if not VENDOR_DIR.is_dir():
        return
    vendor = str(VENDOR_DIR.resolve())
    if vendor not in sys.path:
        sys.path.insert(0, vendor)


ensure_vendor_on_path()

try:
    from smart_dashboard_messages import msg
except ImportError:
    def msg(language: Optional[str], key: str, **kwargs: Any) -> str:
        template = key
        for name, value in kwargs.items():
            template = template.replace("{" + name + "}", str(value))
        return template


PLUGIN_NAME = "Smart Dashboard & Advanced Duplicate Finder"
AUTHOR = "Jaulustus"
DEFAULT_STASH_GRAPHQL_URL = "http://localhost:9999/graphql"
CACHE_DB = PLUGIN_DIR / "cache.db"
DUPLICATES_REPORT = PLUGIN_DIR / "duplicates_report.json"
RECOMMENDATIONS_REPORT = PLUGIN_DIR / "recommendations.json"
REQUIREMENTS_FILE = PLUGIN_DIR / "requirements.txt"
REQUIREMENTS_AGENT_FILE = PLUGIN_DIR / "requirements-agent.txt"
DASHBOARD_DEEP_LINK = "/?smart_dashboard=cinematic"

HASH_SIZE = 8
PHASH_BITS = HASH_SIZE * HASH_SIZE
MAX_HASH_SAMPLES = 8
MIN_HASH_SAMPLES = 3
DUPLICATE_CONFIDENCE_THRESHOLD = 0.90
RECENT_WATCH_DAYS = 90
FORGOTTEN_DAYS = 180
REQUIRED_DEPENDENCIES: Dict[str, Sequence[Tuple[str, str]]] = {
    "smart_dup_scan": (
        ("requests", "requests"),
        ("cv2", "opencv-python"),
        ("numpy", "numpy"),
        ("imagehash", "imagehash"),
    ),
    "smart_dash_calc": (("requests", "requests"),),
    "cleanup_short": (("requests", "requests"),),
    "build_agent_index": (("requests", "requests"),),
    "agent_query": (("requests", "requests"),),
    "agent_index_stats": (("requests", "requests"),),
}


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


def normalize_log_category(category: str) -> str:
    value = str(category or "System").strip().lower()
    if value in ("mcp",):
        return "MCP"
    if value in ("cinematic", "cinema", "dashboard"):
        return "Cinematic"
    return "System"


def task_log_category(task: Optional[str]) -> str:
    if not task:
        return "System"
    normalized = str(task).strip().lower()
    if normalized in {
        "setup_agent",
        "build_agent_index",
        "agent_query",
        "agent_deps_check",
        "agent_setup_log",
        "agent_install_state",
        "agent_mcp_config",
        "agent_index_stats",
    }:
        return "MCP"
    if normalized in {
        "setup",
        "smart_dash_calc",
        "smart_dup_scan",
        "cleanup_short",
        "open_dashboard",
    }:
        return "Cinematic"
    return "System"


def _pip_log_category(label: str) -> str:
    lowered = str(label or "").lower()
    if "mcp" in lowered or "agent" in lowered:
        return "MCP"
    return "Cinematic"


def _trim_plugin_log_file() -> None:
    if not PLUGIN_LOG_FILE.is_file():
        return
    try:
        lines = PLUGIN_LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        if len(lines) <= MAX_PLUGIN_LOG_LINES:
            return
        trimmed = "\n".join(lines[-MAX_PLUGIN_LOG_LINES:]) + "\n"
        PLUGIN_LOG_FILE.write_text(trimmed, encoding="utf-8")
    except OSError:
        pass


def _setup_log_tail(max_lines: int = SETUP_LOG_SNAPSHOT_LINES) -> str:
    text = read_plugin_log()
    lines = text.splitlines()
    if not lines:
        return ""
    return "\n".join(lines[-max(1, int(max_lines)) :])


def refresh_setup_log_snapshot() -> None:
    """Write setup_log tail as JSON so the MCP UI can fetch it without runPluginOperation."""
    try:
        tail = _setup_log_tail()
        write_json_file(
            SETUP_LOG_SNAPSHOT_FILE,
            {
                "setup_log": tail,
                "updated_at": iso_now(),
                "total_lines": len(read_plugin_log().splitlines()),
            },
        )
    except OSError:
        pass


def _write_plugin_log_line(message: str, category: str) -> None:
    text = str(message or "").rstrip()
    if not text:
        return
    cat = normalize_log_category(category)
    stamp = iso_now()[:19].replace("T", " ")
    try:
        with PLUGIN_LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] [{cat}] {text}\n")
        _trim_plugin_log_file()
        refresh_setup_log_snapshot()
    except OSError:
        pass


def log(message: str, category: str = "System") -> None:
    text = str(message or "").rstrip()
    if not text:
        return
    cat = normalize_log_category(category)
    print(f"[{PLUGIN_NAME}] [{cat}] {text}", file=sys.stderr, flush=True)
    _write_plugin_log_line(text, cat)


def append_plugin_log(message: str, category: str = "System") -> None:
    log(message, category)


def append_setup_log(message: str) -> None:
    append_plugin_log(message, "MCP")


def _setup_log_contains(text: str) -> bool:
    needle = str(text or "").strip()
    if not needle or not PLUGIN_LOG_FILE.is_file():
        return False
    try:
        return needle in PLUGIN_LOG_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def append_setup_log_once(message: str, *, marker: Optional[str] = None) -> None:
    if _setup_log_contains(marker or message):
        return
    append_setup_log(message)


def clear_plugin_log() -> None:
    try:
        PLUGIN_LOG_FILE.write_text("", encoding="utf-8")
    except OSError:
        pass


def clear_setup_log() -> None:
    clear_plugin_log()


def _synthesize_setup_log_from_status() -> str:
    status = read_setup_status()
    if not status or status.get("state") in (None, "", "unknown"):
        if VENDOR_DIR.is_dir():
            return (
                f"MCP-Agent-Pakete vermutlich bereits installiert (vendor/ vorhanden).\n"
                f"Pfad: {VENDOR_DIR}\n"
                "Kein Log — nach Plugin-Update MCP- oder Cinematic-Task ausführen, um Einträge zu erzeugen."
            )
        return ""

    lines: List[str] = []
    state = str(status.get("state") or "")
    if state:
        lines.append(f"Status: {state}")
    if status.get("updated_at"):
        lines.append(f"Zuletzt aktualisiert: {status['updated_at']}")
    if status.get("message"):
        lines.append(str(status["message"]))
    if status.get("vendor_path"):
        lines.append(f"vendor: {status['vendor_path']}")
    if status.get("error"):
        lines.append(f"Fehler: {status['error']}")
    deps = status.get("deps")
    if isinstance(deps, dict):
        if deps.get("all_ready"):
            lines.append("Python-Pakete (requests, mcp): installiert")
            if deps.get("python_executable"):
                lines.append(f"Python: {deps['python_executable']}")
        missing = deps.get("missing_packages") or []
        if missing:
            lines.append("Fehlend: " + ", ".join(str(p) for p in missing))
    return "\n".join(lines).strip()


def ensure_setup_log_snapshot(deps: Optional[Dict[str, Any]] = None) -> None:
    """If install already completed but log file is empty, write a one-line snapshot."""
    if SETUP_LOG_FILE.is_file():
        try:
            if SETUP_LOG_FILE.read_text(encoding="utf-8", errors="replace").strip():
                return
        except OSError:
            pass
    checked = deps if deps is not None else check_agent_python_deps({})
    if not checked.get("all_ready"):
        return
    append_setup_log("=== MCP-Agent: Pakete bereits installiert (pip uebersprungen) ===")
    if VENDOR_DIR.is_dir():
        append_setup_log(f"vendor-Verzeichnis: {VENDOR_DIR}")
    if checked.get("python_executable"):
        append_setup_log(f"Python: {checked['python_executable']}")
    try:
        from stash_agent.config import AgentConfig
        from stash_agent.index_store import AgentIndexStore

        stats = AgentIndexStore(AgentConfig.from_env().agent_index_db).get_stats()
        db_path = stats.get("db_path") or str(PLUGIN_DIR / "agent_library.db")
        scene_count = int(stats.get("scene_count") or 0)
        if stats.get("ready") and scene_count > 0:
            append_setup_log(
                f"agent_library.db ist bereit ({scene_count} Szenen, Quelle: {stats.get('index_source') or 'unbekannt'})."
            )
        else:
            append_setup_log(
                f"Naechster Schritt: Bibliotheks-Scan fuer agent_library.db (aktuell {scene_count} Szenen, Pfad: {db_path})."
            )
    except Exception as exc:
        append_setup_log(f"Index-Status konnte nicht gelesen werden: {exc}")
    status = read_setup_status()
    if status.get("state") in (None, "", "unknown"):
        _write_setup_status(
            "success",
            message="MCP agent dependencies already installed (vendor/).",
            deps=checked,
        )


def read_plugin_log() -> str:
    file_text = ""
    if PLUGIN_LOG_FILE.is_file():
        try:
            file_text = PLUGIN_LOG_FILE.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            file_text = ""
    if file_text:
        return file_text
    return _synthesize_setup_log_from_status()


def read_setup_log() -> str:
    return read_plugin_log()


def ensure_runtime_dependencies(task: str) -> None:
    ensure_vendor_on_path()
    required = REQUIRED_DEPENDENCIES.get(task, (("requests", "requests"),))
    for module_name, package_name in required:
        try:
            __import__(module_name)
        except ImportError:
            matching_package = package_name
            break
    else:
        return

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


def read_scan_progress() -> Dict[str, Any]:
    if not SCAN_PROGRESS_FILE.is_file():
        return {}
    try:
        data = json.loads(SCAN_PROGRESS_FILE.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_scan_progress(
    *,
    phase: str,
    scene_count: int = 0,
    total_scenes: Optional[int] = None,
    index_source: Optional[str] = None,
) -> None:
    payload: Dict[str, Any] = {
        "phase": str(phase or "").strip(),
        "scene_count": int(scene_count or 0),
        "total_scenes": int(total_scenes) if total_scenes is not None else None,
        "index_source": index_source,
        "updated_at": iso_now(),
    }
    try:
        write_json_file(SCAN_PROGRESS_FILE, payload)
    except OSError:
        pass


def clear_scan_progress() -> None:
    try:
        SCAN_PROGRESS_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _scene_counts_from_progress_message(message: str) -> tuple[int, Optional[int]]:
    text = str(message or "")
    match = re.search(r"GraphQL Szenen:\s*(\d+)\s*/\s*(\d+)", text, flags=re.IGNORECASE)
    if match:
        return int(match.group(1)), int(match.group(2))
    match = re.search(r"(\d+)\s*/\s*~?(\d+)\s+Szenen", text, flags=re.IGNORECASE)
    if match:
        return int(match.group(1)), int(match.group(2))
    match = re.search(r"(\d+)\s+Szenen", text, flags=re.IGNORECASE)
    if match:
        return int(match.group(1)), None
    match = re.search(r"GraphQL:\s*(\d+)\s+Szenen geladen", text, flags=re.IGNORECASE)
    if match:
        return int(match.group(1)), None
    return 0, None


def make_index_progress_callback(
    *,
    total_scenes: Optional[int] = None,
    index_source: Optional[str] = None,
) -> Any:
    def on_progress(message: str) -> None:
        append_setup_log(message)
        scene_count, parsed_total = _scene_counts_from_progress_message(message)
        effective_total = parsed_total if parsed_total is not None else total_scenes
        current = read_scan_progress()
        if scene_count <= 0:
            scene_count = int(current.get("scene_count") or 0)
        write_scan_progress(
            phase=message,
            scene_count=scene_count,
            total_scenes=effective_total,
            index_source=index_source or current.get("index_source"),
        )

    return on_progress


def get_stash_config_dir(payload: Dict[str, Any]) -> Optional[Path]:
    """Stash config directory (~/.stash) from plugin stdin or UI hints."""
    server_connection = deep_find(payload, ["server_connection", "serverConnection"])
    if isinstance(server_connection, dict):
        dir_value = first_present(server_connection, ["Dir", "dir"])
        if dir_value not in (None, ""):
            path = Path(str(dir_value)).expanduser()
            if path.is_dir():
                return path

    args = get_args_payload(payload)
    for key in ("stash_config_directory", "stashConfigDirectory", "stash_config_path", "stashConfigPath"):
        value = args.get(key)
        if value not in (None, ""):
            path = Path(str(value)).expanduser()
            return path if path.is_dir() else None

    for key in ("stash_config_path", "stashConfigPath", "config_file_path", "configFilePath"):
        value = args.get(key)
        if value in (None, ""):
            continue
        path = Path(str(value)).expanduser()
        if path.is_file():
            return path.parent
        if path.is_dir():
            return path

    for key in ("stash_plugins_path", "pluginsPath", "plugins_path"):
        value = args.get(key)
        if value not in (None, ""):
            plugins = Path(str(value)).expanduser()
            if plugins.is_dir():
                return plugins.parent

    return None


def _read_config_yaml_value(config_path: Path, key: str) -> Optional[str]:
    if not config_path.is_file():
        return None
    prefix = f"{key.lower()}:"
    try:
        for line in config_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if not stripped.lower().startswith(prefix):
                continue
            return stripped.split(":", 1)[1].strip().strip("'\"")
    except OSError:
        return None
    return None


def resolve_python_executable(payload: Optional[Dict[str, Any]] = None) -> str:
    """Python binary for pip — prefers Stash config pythonPath, then absolute sys.executable."""
    payload = payload or {}
    args = get_args_payload(payload)
    for arg_key in ("python_path", "pythonPath", "stash_python_path"):
        raw = args.get(arg_key)
        if raw in (None, ""):
            continue
        text = str(raw).strip()
        found = shutil.which(text)
        if found:
            return found
        path = Path(text).expanduser()
        if path.is_file():
            return str(path.resolve())

    config_dir = get_stash_config_dir(payload)
    if config_dir:
        configured = _read_config_yaml_value(config_dir / "config.yml", "pythonPath")
        if configured:
            found = shutil.which(configured)
            if found:
                return found
            path = Path(configured).expanduser()
            if path.is_file():
                return str(path.resolve())

    executable = sys.executable
    if not Path(executable).is_absolute():
        found = shutil.which(executable)
        if found:
            return found
    return executable


def _write_setup_status(
    state: str,
    *,
    message: Optional[str] = None,
    deps: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
) -> None:
    payload: Dict[str, Any] = {
        "state": state,
        "updated_at": iso_now(),
        "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
    }
    if message:
        payload["message"] = message
    if deps is not None:
        payload["deps"] = deps
    if error:
        payload["error"] = error
    write_json_file(SETUP_STATUS_FILE, payload)


def read_setup_status() -> Dict[str, Any]:
    if not SETUP_STATUS_FILE.is_file():
        return {"state": "unknown"}
    try:
        data = json.loads(SETUP_STATUS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"state": "unknown"}
    except (OSError, json.JSONDecodeError):
        return {"state": "unknown"}


def _vendor_has_mcp_packages() -> bool:
    if not VENDOR_DIR.is_dir():
        return False
    for name in ("mcp", "requests"):
        if (VENDOR_DIR / name).exists():
            return True
    return any("mcp" in entry.name.lower() for entry in VENDOR_DIR.iterdir())


def _agent_db_ready_quick() -> Tuple[bool, int]:
    db_path = PLUGIN_DIR / "agent_library.db"
    if not db_path.is_file() or db_path.stat().st_size < 4096:
        return False, 0
    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
            row = connection.execute("SELECT COUNT(*) AS c FROM scenes").fetchone()
            count = int(row["c"] if row else 0)
            return count > 0, count
    except (OSError, sqlite3.Error):
        return False, 0


def detect_install_state(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Detect MCP/dashboard install progress from files on disk (survives plugin reload).

    Never uses PLUGIN_VERSION / smart_dashboard.yml version to decide whether to reinstall.
    A plugin update only refreshes metadata; vendor/, agent_library.db, and import checks rule.
    """
    payload = payload or {}
    try:
        mcp_deps_ready = bool(check_agent_python_deps(payload).get("all_ready"))
    except Exception:
        mcp_deps_ready = _vendor_has_mcp_packages()

    db_ready, scene_count = _agent_db_ready_quick()
    index_stats: Dict[str, Any] = {}
    index_ready = db_ready
    if db_ready:
        try:
            from stash_agent.config import AgentConfig
            from stash_agent.index_store import AgentIndexStore

            index_stats = AgentIndexStore(AgentConfig.from_env().agent_index_db).get_stats()
            index_ready = bool(index_stats.get("ready") and int(index_stats.get("scene_count") or 0) > 0)
            scene_count = int(index_stats.get("scene_count") or scene_count)
        except Exception:
            index_ready = scene_count > 0

    dashboard_deps = check_dashboard_python_deps()
    return {
        "install_basis": "disk",
        "recorded_plugin_version": PLUGIN_VERSION,
        "updated_at": iso_now(),
        "mcp_deps_ready": mcp_deps_ready,
        "index_ready": index_ready,
        "index_scene_count": scene_count,
        "dashboard_deps_ready": bool(dashboard_deps.get("all_ready")),
        "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
        "agent_library_db": str(PLUGIN_DIR / "agent_library.db"),
        "index": index_stats if index_ready else {},
    }


def write_install_state(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    state = detect_install_state(payload)
    try:
        write_json_file(INSTALL_STATE_FILE, state)
    except OSError:
        pass
    return state


def read_install_state() -> Dict[str, Any]:
    if not INSTALL_STATE_FILE.is_file():
        return {}
    try:
        data = json.loads(INSTALL_STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def reconcile_install_state(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Fix stale setup_status and refresh install_state.json from disk."""
    payload = payload or {}
    state = detect_install_state(payload)
    if state.get("mcp_deps_ready"):
        status = read_setup_status()
        if str(status.get("state") or "").lower() in ("running", "unknown", ""):
            deps = check_agent_python_deps(payload)
            _write_setup_status(
                "success",
                message="MCP dependencies already installed (detected on disk).",
                deps=deps,
            )
    if state.get("index_ready"):
        try:
            write_agent_ui_snapshot(payload)
        except Exception:
            pass
    try:
        write_json_file(INSTALL_STATE_FILE, state)
    except OSError:
        pass
    return state


def _ensure_pip_available(python_executable: str, log_category: str) -> None:
    version_cmd = [python_executable, "-m", "pip", "--version"]
    version_result = subprocess.run(
        version_cmd,
        cwd=str(PLUGIN_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if version_result.returncode == 0:
        if version_result.stdout:
            append_plugin_log(version_result.stdout.strip(), log_category)
        return

    append_plugin_log("pip nicht gefunden, versuche ensurepip (optional).", log_category)
    ensurepip_result = subprocess.run(
        [python_executable, "-m", "ensurepip", "--upgrade"],
        cwd=str(PLUGIN_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if ensurepip_result.stdout:
        for line in ensurepip_result.stdout.splitlines():
            append_plugin_log(line.rstrip(), log_category)
    if ensurepip_result.returncode != 0:
        append_plugin_log(
            "ensurepip nicht verfuegbar — pip muss separat installiert sein (z.B. python3-pip).",
            log_category,
        )


def _pip_install_requirements(
    requirements_path: Path,
    label: str,
    payload: Optional[Dict[str, Any]] = None,
    log_category: Optional[str] = None,
) -> Path:
    if not requirements_path.exists():
        raise SmartDashboardError(f"Requirements-Datei nicht gefunden: {requirements_path}")

    category = log_category or _pip_log_category(label)
    python_executable = resolve_python_executable(payload)
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    _ensure_pip_available(python_executable, category)
    command = [
        python_executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "-r",
        str(requirements_path),
        "-t",
        str(VENDOR_DIR),
        "--no-warn-script-location",
    ]
    append_plugin_log(f"Starte Installation der {label}-Abhaengigkeiten (lokal in vendor/).", category)
    append_plugin_log("Befehl: " + " ".join(command), category)

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
            append_plugin_log(line.rstrip(), category)

    exit_code = process.wait()
    if exit_code != 0:
        append_plugin_log(f"Dependency-Installation fehlgeschlagen (Exit-Code {exit_code}).", category)
        raise SmartDashboardError(f"Dependency-Installation fehlgeschlagen (Exit-Code {exit_code}).")

    ensure_vendor_on_path()
    append_plugin_log(f"{label.capitalize()}-Abhaengigkeiten erfolgreich installiert unter {VENDOR_DIR}.", category)
    return VENDOR_DIR


def get_language(payload: Dict[str, Any]) -> Optional[str]:
    value = (
        os.environ.get("STASH_LANGUAGE")
        or deep_find(payload, ["language", "locale", "ui_language", "uiLanguage"])
    )
    return str(value).strip() if value not in (None, "") else None


def run_setup_dependencies(
    payload: Optional[Dict[str, Any]] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    payload = payload or {}
    install_state = reconcile_install_state(payload)
    deps = check_dashboard_python_deps()
    if deps["all_ready"] or install_state.get("dashboard_deps_ready"):
        append_plugin_log(
            "Cinematic: Dashboard-Abhaengigkeiten sind bereits installiert — pip wird uebersprungen.",
            "Cinematic",
        )
        write_install_state(payload)
        return {
            "message": msg(language, "setup.skipped"),
            "requirements_path": str(REQUIREMENTS_FILE),
            "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
            "deps": deps,
            "skipped": True,
            "install_state": install_state,
        }
    append_plugin_log("Cinematic: Dashboard-Abhaengigkeiten werden installiert (pip → vendor/).", "Cinematic")
    _pip_install_requirements(REQUIREMENTS_FILE, "Dashboard", payload)
    deps = check_dashboard_python_deps()
    append_plugin_log("Cinematic: Dashboard-Abhaengigkeiten installiert.", "Cinematic")
    return {
        "message": msg(language, "setup.done"),
        "requirements_path": str(REQUIREMENTS_FILE),
        "vendor_path": str(VENDOR_DIR),
        "deps": deps,
        "skipped": False,
    }


def get_agent_message(payload: Dict[str, Any], argv: Sequence[str]) -> str:
    args = get_args_payload(payload)
    for source in (
        deep_find(payload, ["message", "query", "prompt"]),
        args.get("message") if isinstance(args, dict) else None,
        args.get("query") if isinstance(args, dict) else None,
    ):
        if isinstance(source, str) and source.strip():
            return source.strip()
    for arg in argv:
        if arg.strip() and arg.strip() not in known_tasks_placeholder():
            return arg.strip()
    return ""


def known_tasks_placeholder() -> set:
    return {
        "setup",
        "setup_agent",
        "build_agent_index",
        "agent_query",
        "agent_deps_check",
        "agent_setup_log",
        "agent_install_state",
        "agent_mcp_config",
        "agent_index_stats",
        "smart_dup_scan",
        "smart_dash_calc",
        "open_dashboard",
        "cleanup_short",
    }


def _check_modules_importable(modules: Sequence[Tuple[str, str]]) -> Dict[str, Any]:
    ensure_vendor_on_path()
    installed: Dict[str, bool] = {}
    missing_packages: List[str] = []
    for module_name, package_name in modules:
        try:
            __import__(module_name)
            installed[module_name] = True
        except ImportError:
            installed[module_name] = False
            missing_packages.append(package_name)
    return {
        "modules": installed,
        "missing_packages": missing_packages,
        "all_ready": not missing_packages,
    }


def check_agent_python_deps(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Report whether MCP agent Python packages are importable in Stash's runtime."""
    payload = payload or {}
    checked = _check_modules_importable((("requests", "requests"), ("mcp", "mcp")))
    modules = checked["modules"]
    return {
        "requests": modules["requests"],
        "mcp": modules["mcp"],
        "all_ready": checked["all_ready"],
        "missing_packages": checked["missing_packages"],
        "requirements_path": str(REQUIREMENTS_AGENT_FILE),
        "python_executable": resolve_python_executable(payload),
        "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
        "already_installed": checked["all_ready"],
    }


def check_dashboard_python_deps() -> Dict[str, Any]:
    """Report whether dashboard Python packages are importable (vendor/ or system)."""
    checked = _check_modules_importable(
        (
            ("requests", "requests"),
            ("cv2", "opencv-python"),
            ("numpy", "numpy"),
            ("imagehash", "imagehash"),
        )
    )
    modules = checked["modules"]
    return {
        "requests": modules["requests"],
        "opencv": modules["cv2"],
        "numpy": modules["numpy"],
        "imagehash": modules["imagehash"],
        "all_ready": checked["all_ready"],
        "missing_packages": checked["missing_packages"],
        "requirements_path": str(REQUIREMENTS_FILE),
        "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
        "already_installed": checked["all_ready"],
    }


def _stash_sqlite_hints_from_payload(payload: Dict[str, Any]) -> List[Path]:
    from stash_agent.stash_db_source import stash_sqlite_paths_from_mapping

    hints = stash_sqlite_paths_from_mapping(get_args_payload(payload))
    config_dir = get_stash_config_dir(payload)
    if config_dir:
        hints.append(config_dir)
        config_file = config_dir / "config.yml"
        if config_file.is_file():
            hints.append(config_file)
    return hints


def _is_quick_check(payload: Dict[str, Any]) -> bool:
    args = get_args_payload(payload)
    raw = first_present(args, ["quick", "quickCheck", "quick_check"])
    if raw in (None, ""):
        return False
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _stash_sqlite_status(payload: Dict[str, Any], *, probe_db: bool) -> Dict[str, Any]:
    stash_sqlite_info: Dict[str, Any] = {"path": None, "available": False, "readable": False, "scene_count": 0}
    try:
        from stash_agent.stash_db_source import probe_stash_sqlite, resolve_stash_sqlite_path

        stash_path = resolve_stash_sqlite_path(_stash_sqlite_hints_from_payload(payload))
        if not stash_path:
            return stash_sqlite_info

        stash_sqlite_info["path"] = str(stash_path)
        stash_sqlite_info["available"] = stash_path.is_file()
        if not probe_db or not stash_path.is_file():
            return stash_sqlite_info

        probe = probe_stash_sqlite(stash_path)
        stash_sqlite_info["readable"] = bool(probe.get("ok"))
        stash_sqlite_info["scene_count"] = int(probe.get("scene_count") or 0)
        if probe.get("error"):
            stash_sqlite_info["error"] = str(probe["error"])
    except Exception as exc:
        stash_sqlite_info["error"] = str(exc)
    return stash_sqlite_info


def write_agent_ui_snapshot(payload: Optional[Dict[str, Any]] = None) -> None:
    """Persist MCP UI state for HTTP asset polling while plugin subprocesses are busy."""
    payload = payload or {}
    try:
        from stash_agent.config import AgentConfig
        from stash_agent.index_store import AgentIndexStore

        deps = check_agent_python_deps(payload)
        stats = AgentIndexStore(AgentConfig.from_env().agent_index_db).get_stats()
        db_path = Path(str(stats.get("db_path") or PLUGIN_DIR / "agent_library.db"))
        db_exists = db_path.is_file()
        db_size_bytes = int(db_path.stat().st_size) if db_exists else 0
        snapshot = {
            "index": stats,
            "environment": {
                "deps": deps,
                "dashboard_deps": check_dashboard_python_deps(),
                "db_exists": db_exists,
                "db_size_bytes": db_size_bytes,
                "db_path": str(db_path),
                "stash_sqlite": _stash_sqlite_status(payload, probe_db=True),
                "stash_config_dir": str(get_stash_config_dir(payload) or ""),
                "index_source": stats.get("index_source"),
                "scan_progress": read_scan_progress(),
            },
            "setup_status": read_setup_status(),
            "setup_log": _setup_log_tail(),
            "updated_at": iso_now(),
        }
        write_json_file(AGENT_UI_SNAPSHOT_FILE, snapshot)
        refresh_setup_log_snapshot()
    except OSError:
        pass


def write_mcp_paths_hint(
    *,
    mcp_server_path: Optional[str] = None,
    python_path: Optional[str] = None,
    graphql_url: Optional[str] = None,
) -> None:
    """Write a small JSON hint for the UI when runPluginOperation is unavailable."""
    try:
        resolved_mcp = mcp_server_path or str((PLUGIN_DIR / "stash_mcp_server.py").resolve())
        payload = {
            "plugin_dir": str(PLUGIN_DIR.resolve()),
            "mcp_server_path": resolved_mcp,
            "python_path": str(python_path or "python"),
            "graphql_url": graphql_url or DEFAULT_STASH_GRAPHQL_URL,
            "updated_at": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        }
        MCP_PATHS_HINT_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


def build_mcp_config_payload(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = payload or {}
    api_key = get_api_key(payload) or ""
    graphql_url = get_graphql_url(payload)
    mcp_server_path = str((PLUGIN_DIR / "stash_mcp_server.py").resolve())
    python_executable = resolve_python_executable(payload)
    args = get_args_payload(payload)
    python_path = first_present(args, ["python_path", "pythonPath"]) or python_executable
    config = {
        "mcpServers": {
            "stash": {
                "command": str(python_path or "python"),
                "args": [mcp_server_path],
                "env": {
                    "STASH_GRAPHQL_URL": graphql_url,
                    "STASH_API_KEY": api_key,
                },
            }
        }
    }
    write_mcp_paths_hint(
        mcp_server_path=mcp_server_path,
        python_path=str(python_path or "python"),
        graphql_url=graphql_url,
    )
    return {
        "graphql_url": graphql_url,
        "api_key": api_key,
        "api_key_configured": bool(api_key),
        "mcp_server_path": mcp_server_path,
        "python_executable": str(python_executable),
        "python_path": str(python_path or "python"),
        "mcp_config": config,
        "mcp_config_json": json.dumps(config, ensure_ascii=False, indent=2),
    }


def run_agent_mcp_config(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return MCP JSON config with API key and absolute paths for the UI."""
    return {
        "message": "MCP configuration",
        **build_mcp_config_payload(payload),
    }


def run_agent_install_state(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Lightweight install probe for UI (files on disk, no new pip/index work)."""
    state = reconcile_install_state(payload)
    return {
        "message": "Install state",
        "install_state": state,
        **state,
    }


def run_agent_setup_log(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Read plugin log (setup_log.txt) and setup_status.json only (no heavy imports)."""
    status = read_setup_status()
    log_text = read_plugin_log()
    if not log_text.strip():
        log_text = _synthesize_setup_log_from_status()
    refresh_setup_log_snapshot()
    try:
        install_state = reconcile_install_state(payload)
        write_agent_ui_snapshot(payload)
    except Exception:
        install_state = read_install_state()
    return {
        "message": "Setup log",
        "setup_log": log_text,
        "setup_status": status,
        "scan_progress": read_scan_progress(),
        "install_state": install_state,
    }


def _prepare_agent_index_shell_if_missing(payload: Dict[str, Any], deps: Dict[str, Any]) -> None:
    """Create an empty agent_library.db as soon as MCP deps are ready (before the full scan task)."""
    if not deps.get("all_ready"):
        return
    from stash_agent.config import AgentConfig
    from stash_agent.index_store import AgentIndexStore

    config = AgentConfig.from_env()
    store = AgentIndexStore(config.agent_index_db)
    if store.db_path.is_file() and store.db_path.stat().st_size > 0:
        return
    try:
        base = stash_base_url_from_graphql_url(get_graphql_url(payload))
        store.begin_build(stash_base_url=base, index_source="pending")
        append_setup_log_once(
            f"agent_library.db angelegt: {store.db_path} — vollstaendiger Scan startet als Stash-Task.",
            marker="agent_library.db angelegt:",
        )
    except OSError as exc:
        append_setup_log_once(
            f"agent_library.db konnte nicht erstellt werden ({store.db_path}): {exc}",
            marker="agent_library.db konnte nicht erstellt werden",
        )


def run_agent_deps_check(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Fast dependency + path check for UI (light SQLite probe when path is known)."""
    payload = payload or {}
    install_state = reconcile_install_state(payload)
    from stash_agent.config import AgentConfig
    from stash_agent.index_store import AgentIndexStore

    agent_deps = check_agent_python_deps(payload)
    ensure_setup_log_snapshot(agent_deps)
    _prepare_agent_index_shell_if_missing(payload, agent_deps)

    stats = AgentIndexStore(AgentConfig.from_env().agent_index_db).get_stats()
    db_path = Path(str(stats.get("db_path") or PLUGIN_DIR / "agent_library.db"))
    db_exists = db_path.is_file()
    db_size_bytes = int(db_path.stat().st_size) if db_exists else 0

    result = {
        "message": msg(None, "agent_index.stats"),
        "index": stats,
        "install_state": install_state,
        "setup_status": read_setup_status(),
        "setup_log": read_setup_log(),
        "scan_progress": read_scan_progress(),
        "environment": {
            "deps": agent_deps,
            "dashboard_deps": check_dashboard_python_deps(),
            "db_exists": db_exists,
            "db_size_bytes": db_size_bytes,
            "db_path": str(db_path),
            "stash_sqlite": _stash_sqlite_status(payload, probe_db=True),
            "stash_config_dir": str(get_stash_config_dir(payload) or ""),
            "index_source": stats.get("index_source"),
            "scan_progress": read_scan_progress(),
        },
    }
    write_agent_ui_snapshot(payload)
    write_install_state(payload)
    return result


def run_agent_index_stats(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    from stash_agent.config import AgentConfig
    from stash_agent.index_store import AgentIndexStore

    payload = payload or {}
    quick = _is_quick_check(payload)
    stats = AgentIndexStore(AgentConfig.from_env().agent_index_db).get_stats()
    db_path = Path(str(stats.get("db_path") or PLUGIN_DIR / "agent_library.db"))
    db_exists = db_path.is_file()
    db_size_bytes = int(db_path.stat().st_size) if db_exists else 0

    result = {
        "message": msg(None, "agent_index.stats"),
        "index": stats,
        "setup_status": read_setup_status(),
        "setup_log": read_setup_log(),
        "scan_progress": read_scan_progress(),
        "environment": {
            "deps": check_agent_python_deps(payload),
            "dashboard_deps": check_dashboard_python_deps(),
            "db_exists": db_exists,
            "db_size_bytes": db_size_bytes,
            "db_path": str(db_path),
            "stash_sqlite": _stash_sqlite_status(payload, probe_db=not quick),
            "stash_config_dir": str(get_stash_config_dir(payload) or ""),
            "index_source": stats.get("index_source"),
            "scan_progress": read_scan_progress(),
        },
    }
    write_agent_ui_snapshot(payload)
    return result


def run_build_agent_index(
    client: GraphQLClient,
    payload: Dict[str, Any],
    language: Optional[str] = None,
) -> Dict[str, Any]:
    del language
    from stash_agent.client import StashAgentClient
    from stash_agent.config import AgentConfig
    from stash_agent.index_builder import build_agent_index
    from stash_agent.index_store import AgentIndexStore

    graphql_url = client.url
    api_key = client.headers.get("ApiKey")
    if graphql_url:
        os.environ["STASH_GRAPHQL_URL"] = graphql_url
    if api_key:
        os.environ["STASH_API_KEY"] = str(api_key)

    config = AgentConfig.from_env()
    agent_client = StashAgentClient(graphql_url, str(api_key) if api_key else None)
    store = AgentIndexStore(config.agent_index_db)
    stash_base_url = stash_base_url_from_graphql_url(graphql_url)
    hints = _stash_sqlite_hints_from_payload(payload)

    append_setup_log("=== Bibliotheks-Index: agent_library.db ===")
    append_setup_log(f"Plugin-Verzeichnis: {PLUGIN_DIR}")
    append_setup_log(f"Ziel-Datei: {store.db_path}")
    try:
        store.begin_build(stash_base_url=stash_base_url, index_source="pending")
        append_setup_log(f"agent_library.db angelegt (Schema bereit, Scan startet …)")
    except OSError as exc:
        append_setup_log(f"agent_library.db konnte nicht angelegt werden: {exc}")
        raise SmartDashboardError(f"Cannot create agent_library.db at {store.db_path}: {exc}") from exc

    if hints:
        append_setup_log("Suchpfade fuer stash-go.sqlite: " + ", ".join(str(h) for h in hints[:8]))
    stash_status = _stash_sqlite_status(payload, probe_db=True)
    if stash_status.get("path"):
        append_setup_log(f"Stash-DB-Kandidat: {stash_status['path']}")
        if stash_status.get("readable"):
            append_setup_log(
                f"Stash-DB lesbar ({int(stash_status.get('scene_count') or 0)} Szenen) — schneller SQLite-Scan."
            )
        elif stash_status.get("available"):
            err = stash_status.get("error") or "nicht lesbar"
            append_setup_log(f"Stash-DB nicht lesbar ({err}) — Fallback GraphQL.")
        else:
            append_setup_log("Stash-DB-Datei nicht gefunden — Scan per GraphQL.")
    else:
        append_setup_log("Kein stash-go.sqlite-Pfad ermittelt — Scan per GraphQL.")
    expected_total = int(stash_status.get("scene_count") or 0) or None
    index_source_hint = "stash_sqlite" if stash_status.get("readable") else "graphql"
    write_scan_progress(
        phase="Bibliotheks-Index gestartet",
        scene_count=0,
        total_scenes=expected_total,
        index_source=index_source_hint,
    )
    on_progress = make_index_progress_callback(
        total_scenes=expected_total,
        index_source=index_source_hint,
    )
    try:
        result = build_agent_index(
            agent_client,
            store,
            config,
            report_path=config.agent_index_report,
            stash_sqlite_hints=hints if hints else None,
            on_progress=on_progress,
        )
    except Exception as exc:
        write_scan_progress(
            phase=f"Index-Aufbau fehlgeschlagen: {exc}",
            scene_count=int(read_scan_progress().get("scene_count") or 0),
            total_scenes=expected_total,
            index_source=index_source_hint,
        )
        append_setup_log(f"Index-Aufbau fehlgeschlagen: {exc}")
        raise
    index_block = result.get("index") if isinstance(result.get("index"), dict) else result
    scene_count = int(
        (index_block or {}).get("scene_count")
        or result.get("scene_count")
        or result.get("scenes")
        or 0
    )
    source = result.get("index_source") or (index_block or {}).get("index_source") or "unbekannt"
    append_setup_log(
        f"=== Index-Aufbau abgeschlossen: {scene_count} Szenen (Quelle: {source}) ==="
    )
    clear_scan_progress()
    write_agent_ui_snapshot(payload)
    write_install_state(payload)
    return result


def run_agent_query(payload: Dict[str, Any], argv: Sequence[str]) -> Dict[str, Any]:
    from stash_agent.service import StashAgentService

    message = get_agent_message(payload, argv)
    if not message:
        raise SmartDashboardError("agent_query requires a non-empty message.")

    preview = message if len(message) <= 160 else message[:160] + "…"
    append_plugin_log(f"Agent-Chat Anfrage: {preview}", "MCP")
    result = StashAgentService.from_config().agent_chat(message, language=get_language(payload))
    scenes = result.get("scenes") if isinstance(result.get("scenes"), list) else []
    reply = str(result.get("reply") or "")
    append_plugin_log(
        f"Agent-Chat Antwort: {len(scenes)} Szenen, Antwortlaenge {len(reply)} Zeichen",
        "MCP",
    )
    return {
        "message": result.get("reply", "Agent reply ready."),
        **result,
    }


def _scan_build_active(max_age_seconds: int = 180) -> bool:
    prog = read_scan_progress()
    phase = str(prog.get("phase") or "").strip()
    updated = str(prog.get("updated_at") or "").strip()
    if not phase or not updated:
        return False
    try:
        stamp = dt.datetime.fromisoformat(updated.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=dt.timezone.utc)
        age = (utc_now() - stamp.astimezone(dt.timezone.utc)).total_seconds()
    except ValueError:
        return False
    return age <= max_age_seconds


def _setup_agent_skip_response(
    payload: Dict[str, Any],
    language: Optional[str],
    deps: Dict[str, Any],
    *,
    message_key: str = "setup_agent.skipped",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    result = {
        "message": msg(language, message_key),
        "requirements_path": str(REQUIREMENTS_AGENT_FILE),
        "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
        "mcp_server_path": str(PLUGIN_DIR / "stash_mcp_server.py"),
        "mcp_config_example": str(PLUGIN_DIR / "mcp-config.example.json"),
        "deps": deps,
        "skipped": True,
        "setup_status": read_setup_status(),
        "setup_log": read_setup_log(),
    }
    if extra:
        result.update(extra)
    write_agent_ui_snapshot(payload)
    return result


def _index_already_complete() -> bool:
    try:
        from stash_agent.config import AgentConfig
        from stash_agent.index_store import AgentIndexStore

        stats = AgentIndexStore(AgentConfig.from_env().agent_index_db).get_stats()
        return bool(stats.get("ready") and int(stats.get("scene_count") or 0) > 0)
    except Exception:
        return False


def _should_chain_index_build(payload: Dict[str, Any], deps: Dict[str, Any]) -> bool:
    if not deps.get("all_ready"):
        return False
    args = get_args_payload(payload)
    raw = first_present(args, ["chain_index_build", "chainIndexBuild", "auto_build_index"])
    if raw is not None and str(raw).strip().lower() in ("0", "false", "no", "off"):
        return False
    return not _index_already_complete()


def _chain_agent_index_build(
    payload: Dict[str, Any],
    language: Optional[str],
    base: Dict[str, Any],
) -> Dict[str, Any]:
    deps = base.get("deps") if isinstance(base.get("deps"), dict) else check_agent_python_deps(payload)
    if not _should_chain_index_build(payload, deps):
        return base
    append_setup_log(
        "=== Bibliotheks-Index (agent_library.db) wird jetzt im gleichen Stash-Task aufgebaut ==="
    )
    ensure_runtime_dependencies("build_agent_index")
    client = make_client(payload, "MCP")
    try:
        index_result = run_build_agent_index(client, payload, language)
        merged = {**base, "index_build": index_result}
        index_block = index_result.get("index") if isinstance(index_result.get("index"), dict) else index_result
        if index_block:
            merged["index"] = index_block
        write_agent_ui_snapshot(payload)
        return merged
    except Exception as exc:
        append_setup_log(f"Index-Aufbau im Setup-Task fehlgeschlagen: {exc}")
        merged = {**base, "index_build_error": str(exc)}
        merged["setup_log"] = read_setup_log()
        return merged


def run_setup_agent_dependencies(
    payload: Optional[Dict[str, Any]] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    payload = payload or {}
    install_state = reconcile_install_state(payload)
    if install_state.get("mcp_deps_ready") and install_state.get("index_ready"):
        append_setup_log_once(
            "Installation bereits abgeschlossen (install_state.json / Dateien auf Platte) — kein erneutes Setup.",
            marker="Installation bereits abgeschlossen",
        )
        deps = check_agent_python_deps(payload)
        _write_setup_status(
            "success",
            message=msg(language, "setup_agent.skipped"),
            deps=deps,
        )
        write_install_state(payload)
        return _setup_agent_skip_response(payload, language, deps)

    deps = check_agent_python_deps(payload)
    if deps["all_ready"]:
        if _index_already_complete():
            append_setup_log_once(
                "agent_library.db ist bereits vorhanden — Setup-Task uebersprungen.",
                marker="agent_library.db ist bereits vorhanden",
            )
            _write_setup_status(
                "success",
                message=msg(language, "setup_agent.skipped"),
                deps=deps,
            )
            return _setup_agent_skip_response(payload, language, deps)

        if _scan_build_active():
            append_setup_log_once(
                "Bibliotheks-Index laeuft bereits — doppelter Setup-Task uebersprungen.",
                marker="Bibliotheks-Index laeuft bereits",
            )
            return _setup_agent_skip_response(
                payload,
                language,
                deps,
                message_key="setup_agent.skipped",
                extra={"index_build_in_progress": True},
            )

        if not _setup_log_contains("=== MCP-Agent: Pakete bereits installiert"):
            append_setup_log("=== MCP-Agent: Pakete bereits installiert (pip uebersprungen) ===")
            if deps.get("python_executable"):
                append_setup_log(f"Python: {deps['python_executable']}")
            if VENDOR_DIR.is_dir():
                append_setup_log(f"vendor-Verzeichnis: {VENDOR_DIR}")
            append_setup_log(
                "Naechster Schritt: Bibliotheks-Scan (agent_library.db) — startet automatisch in der MCP-UI "
                "oder per Task „Build agent library index“."
            )
        _write_setup_status(
            "success",
            message=msg(language, "setup_agent.skipped"),
            deps=deps,
        )
        result = {
            "message": msg(language, "setup_agent.skipped"),
            "requirements_path": str(REQUIREMENTS_AGENT_FILE),
            "vendor_path": str(VENDOR_DIR) if VENDOR_DIR.is_dir() else None,
            "mcp_server_path": str(PLUGIN_DIR / "stash_mcp_server.py"),
            "mcp_config_example": str(PLUGIN_DIR / "mcp-config.example.json"),
            "deps": deps,
            "skipped": True,
            "setup_status": read_setup_status(),
            "setup_log": read_setup_log(),
        }
        return _chain_agent_index_build(payload, language, result)

    append_plugin_log("--- MCP-Agent-Einrichtung (pip) ---", "MCP")
    python_executable = resolve_python_executable(payload)
    append_setup_log("=== MCP-Agent-Einrichtung gestartet (pip → vendor/) ===")
    append_setup_log(f"Python: {python_executable}")
    append_setup_log(f"Requirements: {REQUIREMENTS_AGENT_FILE}")
    _write_setup_status(
        "running",
        message="Installing MCP agent dependencies (requests, mcp) into vendor/",
    )
    try:
        _pip_install_requirements(REQUIREMENTS_AGENT_FILE, "MCP-Agent", payload)
        deps = check_agent_python_deps(payload)
        if not deps.get("all_ready"):
            error_text = "Dependencies missing after pip install."
            _write_setup_status("failed", message=error_text, deps=deps, error=error_text)
            raise SmartDashboardError(error_text)
        append_setup_log("=== MCP pip-Installation erfolgreich ===")
        append_setup_log(
            "Naechster Schritt: Bibliotheks-Scan (agent_library.db) — in der MCP-UI automatisch "
            "oder Task „Build agent library index“."
        )
        _write_setup_status(
            "success",
            message=msg(language, "setup_agent.done"),
            deps=deps,
        )
        write_install_state(payload)
        result = {
            "message": msg(language, "setup_agent.done"),
            "requirements_path": str(REQUIREMENTS_AGENT_FILE),
            "vendor_path": str(VENDOR_DIR),
            "mcp_server_path": str(PLUGIN_DIR / "stash_mcp_server.py"),
            "mcp_config_example": str(PLUGIN_DIR / "mcp-config.example.json"),
            "deps": deps,
            "skipped": False,
            "setup_status": read_setup_status(),
            "setup_log": read_setup_log(),
        }
        return _chain_agent_index_build(payload, language, result)
    except Exception as exc:
        try:
            deps = check_agent_python_deps(payload)
        except Exception:
            deps = None
        _write_setup_status("failed", message=str(exc), deps=deps, error=str(exc))
        raise


def run_open_dashboard(payload: Dict[str, Any]) -> Dict[str, Any]:
    stash_base_url = stash_base_url_from_graphql_url(get_graphql_url(payload))
    dashboard_url = f"{stash_base_url.rstrip('/')}{DASHBOARD_DEEP_LINK}"
    return {
        "message": msg(get_language(payload), "dashboard.open", url=dashboard_url),
        "dashboard_url": dashboard_url,
    }


def _stdin_has_data() -> bool:
    if sys.stdin is None or sys.stdin.isatty():
        return False

    try:
        if hasattr(sys.stdin, "buffer"):
            return bool(sys.stdin.buffer.peek(1))
    except (OSError, ValueError, io.UnsupportedOperation):
        pass

    return False


def read_stash_payload() -> Dict[str, Any]:
    if sys.stdin is None or sys.stdin.isatty():
        return {}

    if not _stdin_has_data():
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
    known_tasks = {
        "setup",
        "setup_agent",
        "build_agent_index",
        "agent_query",
        "agent_deps_check",
        "agent_setup_log",
        "agent_install_state",
        "agent_mcp_config",
        "agent_index_stats",
        "smart_dup_scan",
        "smart_dash_calc",
        "open_dashboard",
        "cleanup_short",
    }

    args = get_args_payload(payload)
    for key in ("task", "mode"):
        value = args.get(key)
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned in known_tasks:
                return cleaned

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


def _parse_api_key_from_config_file(config_path: Path) -> Optional[str]:
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
        lowered = stripped.lower()
        if lowered.startswith("api_key:") or lowered.startswith("apikey:"):
            value = stripped.split(":", 1)[1].strip().strip("'\"")
            return value or None
    return None


def read_api_key_from_stash_config(payload: Dict[str, Any]) -> Optional[str]:
    args = get_args_payload(payload)
    config_paths: List[Path] = []
    for key in ("stash_config_path", "stashConfigPath", "config_file_path", "configFilePath"):
        value = args.get(key)
        if value not in (None, ""):
            config_paths.append(Path(str(value)).expanduser())
    config_dir = get_stash_config_dir(payload)
    if config_dir:
        config_paths.append(config_dir / "config.yml")
    for path in config_paths:
        found = _parse_api_key_from_config_file(path)
        if found:
            return found.strip()
    return None


def get_api_key(payload: Dict[str, Any]) -> Optional[str]:
    value = (
        os.environ.get("STASH_API_KEY")
        or os.environ.get("STASH_APIKEY")
        or os.environ.get("STASH_API_TOKEN")
        or deep_find(payload, ["api_key", "apiKey", "apikey", "api_token", "apiToken", "ApiKey"])
    )
    if value in (None, ""):
        value = read_api_key_from_stash_config(payload)
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
            log(f"GraphQL Query-Variante '{name}' erfolgreich: {len(scenes)} Szenen geladen.", "Cinematic")
            return scenes, name
        except GraphQLClientError as exc:
            last_error = exc
            log(f"GraphQL Query-Variante '{name}' nicht nutzbar: {exc}", "Cinematic")

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
    for key in ("args", "args_map", "argsMap"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    nested = deep_find(payload, ["args", "args_map", "argsMap"])
    return nested if isinstance(nested, dict) else {}


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


def run_duplicate_scan(client: GraphQLClient, language: Optional[str] = None) -> Dict[str, Any]:
    append_plugin_log("Cinematic: Duplikat-Scan (pHash) gestartet …", "Cinematic")
    cv2, np = ensure_video_dependencies()
    scenes, query_variant = fetch_scenes_with_variants(client, DUP_QUERY_VARIANTS)
    append_plugin_log(f"Cinematic: {len(scenes)} Szenen fuer Duplikat-Scan geladen.", "Cinematic")
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
                log(f"Duplikatscan Fortschritt: {index}/{len(scenes)} Szenen verarbeitet.", "Cinematic")
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
                    f"{left.scene_id} <-> {right.scene_id} ({confidence:.1%})",
                    "Cinematic",
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
    append_plugin_log(
        "Cinematic: Duplikat-Scan abgeschlossen — "
        f"{len(duplicates)} Gruppen, {len(hashed_scenes)} gehasht, "
        f"{cache_hits} Cache-Treffer, {len(skipped)} uebersprungen.",
        "Cinematic",
    )

    return {
        "message": msg(
            language,
            "duplicates.done",
            groups=len(duplicates),
            hashed=len(hashed_scenes),
            cache=cache_hits,
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


def run_cleanup_short(
    client: GraphQLClient, max_duration_seconds: float, language: Optional[str] = None
) -> Dict[str, Any]:
    append_plugin_log(
        f"Cinematic: Kurzvideo-Cleanup gestartet (unter {max_duration_seconds:g}s) …",
        "Cinematic",
    )
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
        f"{missing_duration} ohne Dauer).",
        "Cinematic",
    )

    deleted = 0
    deleted_scene_ids: List[str] = []
    failed: List[Dict[str, str]] = []
    for scene_id, title, path, duration in candidates:
        log(
            f"Entferne kurze Szene aus Stash: {scene_id} | {duration:.2f}s | {title} | {path or 'kein Pfad'}",
            "Cinematic",
        )
        try:
            if destroy_scene_record_only(client, scene_id):
                deleted += 1
                deleted_scene_ids.append(scene_id)
            else:
                failed.append({"scene_id": scene_id, "title": title, "reason": "sceneDestroy gab false zurueck"})
        except Exception as exc:
            failed.append({"scene_id": scene_id, "title": title, "reason": str(exc)})
            log(f"Fehler beim Loeschen von Szene {scene_id}: {exc}", "Cinematic")

    removed_recommendation_items = remove_deleted_scenes_from_recommendations(deleted_scene_ids)
    append_plugin_log(
        f"Cinematic: Cleanup abgeschlossen — {deleted} geloescht, {len(failed)} fehlgeschlagen, "
        f"{removed_recommendation_items} Empfehlungseinträge bereinigt.",
        "Cinematic",
    )

    return {
        "message": msg(
            language,
            "cleanup.done",
            deleted=deleted,
            matched=len(candidates),
            seconds=f"{max_duration_seconds:g}",
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
        "stream_url": f"{stash_base_url.rstrip('/')}/scene/{scene_id}/stream",
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


def run_dashboard_calc(client: GraphQLClient, language: Optional[str] = None) -> Dict[str, Any]:
    append_plugin_log("Cinematic: Empfehlungen werden berechnet …", "Cinematic")
    scenes, query_variant = fetch_scenes_with_variants(client, DASH_QUERY_VARIANTS)
    append_plugin_log(
        f"Cinematic: {len(scenes)} Szenen geladen (GraphQL-Variante: {query_variant}).",
        "Cinematic",
    )
    stash_base_url = stash_base_url_from_graphql_url(client.url)
    tag_scores, studio_scores = build_preference_counters(scenes)

    forgotten_gems: List[Dict[str, Any]] = []
    for scene_index, scene in enumerate(scenes, start=1):
        if scene_index % 500 == 0:
            append_plugin_log(
                f"Cinematic: Empfehlungen — {scene_index}/{len(scenes)} Szenen ausgewertet …",
                "Cinematic",
            )
        rating = normalize_rating(scene)
        last_days = days_since(scene.get("last_played_at"))
        if rating is not None and rating >= 4.0 and last_days is not None and last_days > FORGOTTEN_DAYS:
            score = rating + min(last_days / 365.0, 3.0) + min(play_count(scene), 10) * 0.05
            forgotten_gems.append(
                recommendation_item(
                    scene,
                    score,
                    f"Rating {rating}/5 and not watched for {last_days} days",
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
            reasons.append("not watched yet")
        reason = "; ".join(reasons) if reasons else f"High rating ({rating}/5)"
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
        reason = "; ".join(reasons) if reasons else "From your Stash library"
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
        "library_stats": {
            "total_scenes": len(scenes),
            "estimated_recommendation_seconds": max(5, round(len(scenes) / 80)),
        },
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
    append_plugin_log(
        "Cinematic: Empfehlungen gespeichert — "
        f"{len(report['forgotten_gems'])} Forgotten Gems, "
        f"{len(report['smart_suggestions'])} Smart Suggestions, "
        f"{len(report['top_rated'])} Top Rated.",
        "Cinematic",
    )

    return {
        "message": msg(
            language,
            "recommendations.updated",
            forgotten=len(report["forgotten_gems"]),
            smart=len(report["smart_suggestions"]),
        ),
        "report_path": str(RECOMMENDATIONS_REPORT),
        "forgotten_gems": len(report["forgotten_gems"]),
        "smart_suggestions": len(report["smart_suggestions"]),
    }


def log_task_start(task: str) -> None:
    descriptions = {
        "setup": "Cinematic: Dashboard-Abhaengigkeiten installieren",
        "setup_agent": "MCP: Agent-Abhaengigkeiten installieren",
        "build_agent_index": "MCP: Bibliotheks-Index (agent_library.db) aufbauen",
        "agent_query": "MCP: Agent-Chat",
        "smart_dash_calc": "Cinematic: Empfehlungen berechnen",
        "smart_dup_scan": "Cinematic: Duplikat-Scan",
        "cleanup_short": "Cinematic: Kurzvideo-Cleanup",
    }
    append_plugin_log(
        descriptions.get(task, f"Task gestartet: {task}"),
        task_log_category(task),
    )


def make_client(payload: Dict[str, Any], log_category: str = "System") -> GraphQLClient:
    url = get_graphql_url(payload)
    api_key = get_api_key(payload)
    cookie = get_session_cookie(payload)
    log(f"Verbinde mit Stash GraphQL: {url}", log_category)
    return GraphQLClient(url=url, api_key=api_key, cookie=cookie)


def success_response(result: Dict[str, Any], language: Optional[str] = None) -> Dict[str, Any]:
    return {
        "output": result.get("message", msg(language, "plugin.done")),
        "result": result,
    }


def error_response(exc: Exception, language: Optional[str] = None) -> Dict[str, Any]:
    print(f"[{PLUGIN_NAME}] {exc}", file=sys.stderr, flush=True)
    return {
        "output": msg(language, "plugin.error", error=exc),
        "error": str(exc),
    }


def main() -> None:
    payload = read_stash_payload()
    write_mcp_paths_hint(
        python_path=str(resolve_python_executable(payload) or "python"),
        graphql_url=get_graphql_url(payload),
    )
    try:
        reconcile_install_state(payload)
        if PLUGIN_LOG_FILE.is_file():
            refresh_setup_log_snapshot()
    except Exception:
        pass
    task = detect_task(sys.argv[1:], payload)
    language = get_language(payload)
    active_task = task

    try:
        if not task:
            response = {
                "output": msg(language, "plugin.ready"),
                "plugin": PLUGIN_NAME,
                "author": AUTHOR,
            }
        elif task == "setup":
            log_task_start(task)
            response = success_response(run_setup_dependencies(payload, language), language)
        elif task == "setup_agent":
            deps = check_agent_python_deps(payload)
            if deps.get("all_ready"):
                if _index_already_complete():
                    append_plugin_log(
                        "MCP: agent_library.db ist bereit — kein Setup noetig.",
                        "MCP",
                    )
                elif _scan_build_active():
                    append_plugin_log(
                        "MCP: Bibliotheks-Index laeuft bereits — doppelter Task uebersprungen.",
                        "MCP",
                    )
                else:
                    append_plugin_log(
                        "MCP: pip bereits erledigt — starte Bibliotheks-Index (agent_library.db).",
                        "MCP",
                    )
            else:
                log_task_start(task)
            response = success_response(run_setup_agent_dependencies(payload, language), language)
        elif task == "agent_deps_check":
            response = success_response(run_agent_deps_check(payload), language)
        elif task == "agent_setup_log":
            response = success_response(run_agent_setup_log(payload), language)
        elif task == "agent_install_state":
            response = success_response(run_agent_install_state(payload), language)
        elif task == "agent_mcp_config":
            response = success_response(run_agent_mcp_config(payload), language)
        elif task == "agent_index_stats":
            response = success_response(run_agent_index_stats(payload), language)
        elif task == "agent_query":
            log_task_start(task)
            ensure_runtime_dependencies(task)
            response = success_response(run_agent_query(payload, sys.argv[1:]), language)
        elif task == "open_dashboard":
            response = success_response(run_open_dashboard(payload), language)
        else:
            log_task_start(task)
            ensure_runtime_dependencies(task)
            category = task_log_category(task)
            client = make_client(payload, category)
            if task == "build_agent_index":
                response = success_response(run_build_agent_index(client, payload, language), language)
            elif task == "smart_dup_scan":
                response = success_response(run_duplicate_scan(client, language), language)
            elif task == "smart_dash_calc":
                response = success_response(run_dashboard_calc(client, language), language)
            elif task == "cleanup_short":
                max_duration = get_cleanup_max_duration(sys.argv[1:], payload)
                response = success_response(run_cleanup_short(client, max_duration, language), language)
            else:
                raise SmartDashboardError(msg(language, "task.unknown", task=task))
    except SmartDashboardError as exc:
        append_plugin_log(str(exc), task_log_category(active_task))
        response = error_response(exc, language)
    except Exception as exc:
        append_plugin_log(traceback.format_exc(), task_log_category(active_task))
        response = error_response(SmartDashboardError(f"Unexpected error: {exc}"), language)

    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()