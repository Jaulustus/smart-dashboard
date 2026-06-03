# Stash MCP — Verbindungsanleitung (Deutsch)

Die **vollständige Dokumentation** liegt in der [README.md](README.md):

- **[Schnellstart (GitHub-Link erhalten)](README.md#quick-start-you-received-the-github-link)** — für Nutzer und KI-Assistenten (Checkliste + Befehle)
- **[MCP (Model Context Protocol)](README.md#mcp-model-context-protocol)** — Cursor, Claude Desktop, OpenClaw, Tools, Fehlerbehebung

## Schnellstart (Nutzer)

1. Plugin-Ordner unter **Einstellungen → System → Plugin-Pfad** (z. B. `…/plugins/community/smart-dashboard`)  
2. **Plugins neu laden** (Version **0.3.0**)  
3. Stash → **MCP-Server** → Setup abwarten oder **Gesamte Bibliothek scannen**  
4. **MCP-Config kopieren** und in Cursor / Claude / OpenClaw einfügen  
5. KI-Client neu starten  

**OpenClaw auf anderem Gerät:** Ordner `smart-dashboard` mit `stash_mcp_server.py` + `stash_agent/` ins Workspace legen.

**Häufiger Irrtum:** `agent_library.db` enthält **Szenen/Tags** (Suchindex), **keine** MCP-Commands. Tools heißen `stash_*` und kommen vom MCP-Server — zuerst **`stash_list_mcp_tools`** aufrufen. Wenn der Index leer ist: `stash_rebuild_agent_index` oder `agent_library.db` vom Stash-Server kopieren. `requirements-agent.txt` ist **nicht** nötig — fehlende Pakete installiert `stash_mcp_server.py` beim ersten Start nach `vendor/`. GraphQL-URL muss die **Stash-Server-IP** sein (nicht `localhost` auf dem OpenClaw-PC).  

Terminal nur bei fehlgeschlagenen Stash-Tasks — siehe README-Befehle unter *Quick start*.

## Was die KI für dich tun kann (MCP)

| Deine Frage | MCP-Tool |
|-------------|----------|
| Welche Befehle gibt es? / Was kann die KI? | **`stash_list_mcp_tools`** (nicht in `agent_library.db` nachschauen!) |
| Wie groß ist die Bibliothek? | `stash_agent_library_overview`, `stash_get_library_stats` |
| Szenen suchen / zusammenfassen | `stash_agent_chat`, `stash_agent_search_index`, `stash_search_scenes` |
| Eine Szene anzeigen | `stash_get_scene` |
| Tags, Darsteller, Studio, Titel, Bewertung ändern | `stash_update_scene` (Tags mit `tag_mode: "add"` sicher) |
| Duplikat-Report anzeigen | `stash_list_duplicate_groups` (nach Duplikat-Scan in Cinematic) |
| Index nach Import aktualisieren | `stash_rebuild_agent_index` |

**Nicht per MCP:** Video-Dateien löschen, Duplikat-Scan starten (nur Report lesen), Stash-Einstellungen ändern.

Vollständige Tool-Tabelle: [README → MCP tools the AI can run](README.md#mcp-tools-the-ai-can-run-command-reference)  
**Beispiel-Aufrufe mit Parametern:** [README → Example MCP tool calls](README.md#example-mcp-tool-calls-parameters-for-the-ai)

## Für KI-Assistenten (Kurzfassung)

Wenn dir ein Nutzer `https://github.com/Jaulustus/smart-dashboard` schickt: Kein Neuinstall bei 0.3.x-Updates; Config aus Stash **MCP-Server** kopieren; Pfad oft `community/smart-dashboard`. Nutze `stash_agent_*` zum Suchen, `stash_get_scene` / `stash_update_scene` zum Bearbeiten, `stash_rebuild_agent_index` nach großen Änderungen. Details: [README → For AI agents](README.md#for-ai-agents-when-the-user-shares-this-link-or-readme).
