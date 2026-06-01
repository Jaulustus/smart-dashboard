from __future__ import annotations

from typing import Any, Dict, Optional


def normalize_locale(language: Optional[str]) -> str:
    if not language:
        return "en"
    raw = str(language).strip().lower().replace("_", "-")
    if raw.startswith("zh") and ("tw" in raw or "hk" in raw or "hant" in raw):
        return "zh-tw"
    base = raw.split("-")[0]
    return base if base in _MESSAGES else "en"


_MESSAGES: Dict[str, Dict[str, str]] = {
    "en": {
        "plugin.ready": (
            "Smart Dashboard plugin ready. Known tasks: "
            "setup, setup_agent, build_agent_index, agent_query, agent_deps_check, agent_index_stats, "
            "smart_dup_scan, smart_dash_calc, open_dashboard, cleanup_short."
        ),
        "plugin.done": "Smart Dashboard task completed.",
        "plugin.error": "Smart Dashboard error: {error}",
        "task.unknown": "Unknown task: {task}",
        "setup.done": "Setup complete: Python dependencies installed.",
        "setup.skipped": "Dashboard dependencies are already installed — nothing to do.",
        "setup_agent.done": (
            "MCP setup complete: agent dependencies installed (requests, mcp). "
            "Configure MCP clients with stash_mcp_server.py."
        ),
        "setup_agent.skipped": "MCP agent dependencies are already installed — nothing to do.",
        "dashboard.open": (
            "Dashboard: {url} | If no data appears yet, refresh recommendations in Cinematic first."
        ),
        "recommendations.updated": (
            "Dashboard recommendations updated: {forgotten} Forgotten Gems, {smart} Smart Suggestions."
        ),
        "duplicates.done": (
            "Duplicate scan finished: {groups} candidates, {hashed} scenes hashed, {cache} cache hits."
        ),
        "cleanup.done": (
            "Short-video cleanup finished: removed {deleted}/{matched} scenes under {seconds}s. "
            "Files were not deleted from disk."
        ),
        "agent_index.built": "Agent library index built with {scenes} scenes.",
        "agent_index.stats": "Agent index status loaded.",
    },
    "de": {
        "plugin.ready": (
            "Smart-Dashboard-Plugin bereit. Bekannte Tasks: "
            "setup, setup_agent, build_agent_index, agent_query, agent_deps_check, agent_index_stats, "
            "smart_dup_scan, smart_dash_calc, open_dashboard, cleanup_short."
        ),
        "plugin.done": "Smart-Dashboard-Aufgabe abgeschlossen.",
        "plugin.error": "Smart-Dashboard-Fehler: {error}",
        "task.unknown": "Unbekannter Task: {task}",
        "setup.done": "Setup abgeschlossen: Python-Abhängigkeiten wurden installiert.",
        "setup.skipped": "Dashboard-Abhängigkeiten sind bereits installiert — keine Installation nötig.",
        "setup_agent.done": (
            "MCP-Setup abgeschlossen: Agent-Abhängigkeiten installiert (requests, mcp). "
            "MCP-Clients mit stash_mcp_server.py konfigurieren."
        ),
        "setup_agent.skipped": "MCP-Agent-Abhängigkeiten sind bereits installiert — keine Installation nötig.",
        "dashboard.open": (
            "Dashboard: {url} | Falls noch keine Daten angezeigt werden, "
            "starte zuerst die Empfehlungen in Cinematic neu."
        ),
        "recommendations.updated": (
            "Dashboard-Empfehlungen aktualisiert: {forgotten} Vergessene Perlen, "
            "{smart} Smarte Vorschläge."
        ),
        "duplicates.done": (
            "Duplikat-Scan abgeschlossen: {groups} Kandidaten, {hashed} Szenen gehasht, {cache} Cache-Treffer."
        ),
        "cleanup.done": (
            "Kurzvideo-Bereinigung abgeschlossen: {deleted}/{matched} Szenen unter {seconds}s aus Stash entfernt. "
            "Dateien wurden nicht gelöscht."
        ),
        "agent_index.built": "Agent-Bibliotheksindex mit {scenes} Szenen erstellt.",
        "agent_index.stats": "Agent-Index-Status geladen.",
    },
}


def msg(language: Optional[str], key: str, **kwargs: Any) -> str:
    locale = normalize_locale(language)
    catalog = _MESSAGES.get(locale) or _MESSAGES["en"]
    template = catalog.get(key) or _MESSAGES["en"].get(key) or key
    try:
        return template.format(**kwargs)
    except KeyError:
        return template
