(function () {
  "use strict";

  function nest(flat) {
    const root = {};
    Object.entries(flat).forEach(([key, value]) => {
      const parts = key.split(".");
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        node[parts[index]] = node[parts[index]] || {};
        node = node[parts[index]];
      }
      node[parts[parts.length - 1]] = value;
    });
    return root;
  }

  function flatten(tree, prefix) {
    const out = {};
    Object.entries(tree || {}).forEach(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(out, flatten(value, path));
      } else {
        out[path] = value;
      }
    });
    return out;
  }

  const EN_FLAT = {
    "nav.cinematic": "Cinematic",
    "nav.mcp_server": "MCP-Server",
    "app.title": "Stash Cinematic",
    "app.brand": "Stash",
    "hero.featured": "Featured Scene",
    "hero.play": "Play",
    "hero.refresh": "Refresh",
    "hero.defaultDescription": "A standout recommendation selected from your local Stash library.",
    "hero.generateHint": "Generate recommendations to unlock your cinematic dashboard.",
    "row.library_spotlight.title": "Library Spotlight",
    "row.library_spotlight.subtitle": "A reliable fallback row from your local scene library.",
    "row.forgotten_gems.title": "Forgotten Gems",
    "row.forgotten_gems.subtitle": "Highly rated scenes waiting for a comeback.",
    "row.top_rated.title": "Top Rated",
    "row.top_rated.subtitle": "The highest-rated scenes in your library.",
    "row.recently_watched.title": "Recently Watched",
    "row.recently_watched.subtitle": "Continue the mood from your latest sessions.",
    "row.smart_suggestions.title": "Smart Suggestions",
    "row.smart_suggestions.subtitle": "Generated from ratings, tags, studios, and watch history.",
    "row.scenesCount": "{count} scenes",
    "row.scrollLeft": "Scroll {title} left",
    "row.scrollRight": "Scroll {title} right",
    "random.title": "Random Picks",
    "random.subtitle": "Six random videos from your full Stash library.",
    "random.refresh": "Refresh Picks",
    "random.loading": "Loading...",
    "search.kicker": "Search",
    "search.title": "Cinematic Search",
    "search.description": "Search the full Stash library by title, filename, or tags.",
    "search.titleLabel": "Title or filename",
    "search.tagsLabel": "Tags (comma-separated)",
    "search.titlePlaceholder": "Scene title or file name",
    "search.tagsPlaceholder": "tag, another tag",
    "search.button": "Search Library",
    "search.searching": "Searching...",
    "search.error.empty": "Enter a title, filename, or tag to search.",
    "search.info.searching": "Searching the full Stash library...",
    "search.noResults": "No matching scenes found.",
    "search.results.title": "Search Results",
    "search.results.subtitle": "{count} total match in your Stash library.",
    "search.results.subtitle_plural": "{count} total matches in your Stash library.",
    "player.nowPlaying": "Now Playing",
    "player.openInStash": "Open in Stash",
    "player.close": "Close player",
    "card.openInStash": "Open in Stash",
    "card.plays": "{count} plays",
    "card.unrated": "Unrated",
    "stats.videos": "Videos in Stash",
    "stats.estimated": "Estimated Build Time",
    "stats.spotlight": "Library Spotlight",
    "stats.suggestions": "Smart Suggestions",
    "topTags.title": "From Your Top Tags",
    "topTags.subtitle": "Prioritized from: {tags}",
    "loading.cinematic": "Loading Stash Cinematic...",
    "empty.noRows": "No recommendation rows yet",
    "empty.noRowsHint": "Click 'Refresh Recommendations' above to rebuild the rows.",
    "error.recommendationsNotFound": "recommendations.json not found",
    "error.recommendationsHint":
      "Click 'Refresh Recommendations' to rebuild the Cinematic rows. Library Tools remain available.",
    "error.reportUnavailable": "The local report is unavailable. Check the Stash logs for details.",
    "topbar.libraryTools": "Library tools available",
    "topbar.refresh": "Refresh Recommendations",
    "topbar.refreshBusy": "Working...",
    "topbar.uiMeta": "UI {version} • Updated {date} • {count} videos • est. {duration}{extra}",
    "topbar.uiMetaNoDate": "UI {version} • {count} videos • est. {duration}{extra}",
    "topbar.autostart": " • recommendations started (~{duration})",
    "refresh.rebuilding": "Rebuilding recommendations...",
    "refresh.jobStarted": "Recommendations started as a background job. Job ID: {jobId}. Reload after it finishes.",
    "refresh.done": "Recommendations were rebuilt and reloaded.",
    "refresh.failed": "Recommendations could not be rebuilt. Check the Stash logs for details.",
    "tasks.kicker": "Plugin Tasks",
    "tasks.title": "Run Tasks in Cinematic",
    "tasks.description":
      "Setup starts automatically the first time Cinematic opens. You can also start every important plugin task manually here.",
    "tasks.setup.title": "Setup",
    "tasks.setup.description": "Installs or updates Python dependencies.",
    "tasks.setup.button": "Start Setup",
    "tasks.setup.autoStarted": "Automatic setup started. Job ID: {jobId}",
    "tasks.setup.autoDone": "Automatic setup completed directly.",
    "tasks.setup.autoFailed": "Automatic setup could not be started. Check the Stash logs for details.",
    "tasks.setup.already": "Setup has already been started for this browser.",
    "tasks.recommendations.title": "Recommendations",
    "tasks.recommendations.description": "Rebuilds recommendations.json for Cinematic.",
    "tasks.recommendations.button": "Refresh Recommendations",
    "tasks.recommendations.autostart": "Started automatically.",
    "tasks.duplicates.title": "Duplicate Scan",
    "tasks.duplicates.description": "Starts the visual pHash duplicate scan.",
    "tasks.duplicates.button": "Start Duplicate Scan",
    "tasks.starting": "Starting task...",
    "tasks.started": "Started. Job ID: {jobId}",
    "tasks.done": "Completed directly. Reload the report or dashboard afterwards.",
    "tasks.failed": "Could not be started. Check the Stash logs for details.",
    "duplicates.kicker": "Duplicate Results",
    "duplicates.title": "Duplicate Scan Results",
    "duplicates.description":
      "Candidates from duplicates_report.json appear here after the duplicate scan has finished.",
    "duplicates.reload": "Reload Report",
    "duplicates.loading": "Loading duplicate report...",
    "duplicates.empty": "No duplicate report found yet.",
    "duplicates.emptyHint": "Start the duplicate scan in Cinematic, then reload this report.",
    "duplicates.candidates": "Candidates: {count}",
    "duplicates.hashed": "Hashed: {done}/{total}",
    "duplicates.cache": "Cache: {count}",
    "duplicates.skipped": "Skipped: {count}",
    "duplicates.updated": "Updated: {date}",
    "duplicates.none": "No duplicate candidates in the latest report.",
    "duplicates.distance": "Distance {value}",
    "cleanup.kicker": "Library Tools",
    "cleanup.title": "Short-Video Cleanup",
    "cleanup.description": "Remove scenes below a custom duration from Stash. The original video files stay on disk.",
    "cleanup.label": "Delete videos shorter than (minutes:seconds):",
    "cleanup.hint": "Scenes below this duration will be removed from Stash only.",
    "cleanup.placeholder": "0:30 or 90",
    "cleanup.purge": "Purge",
    "cleanup.purging": "Starting...",
    "cleanup.warning":
      "Stash cleanup only: matching scene records are removed with sceneDestroy(delete_file: false). Examples: 0:30, 1:15, 90.",
    "cleanup.confirm":
      "This removes all scenes shorter than {seconds} seconds ({input}) from Stash only.\n\nThe original video files stay on disk. Matching scenes will no longer appear in Stash.\n\nContinue?",
    "cleanup.invalid": "Please enter a valid duration, for example 0:30, 1:15, or 90.",
    "cleanup.running": "Cleanup is running...",
    "cleanup.done": "Cleanup finished. Check the Stash logs for details.",
    "cleanup.failed": "Cleanup could not be started. Check the Stash logs for details.",
    "mcp.installing": "Installing MCP agent dependencies (requirements-agent.txt)...",
    "mcp.started": "MCP install started. Job ID: {jobId}. Watch Stash logs for pip output.",
    "mcp.done": "MCP agent dependencies installed. Add stash_mcp_server.py to your MCP client config.",
    "mcp.failed": "MCP install failed. Check the Stash plugin logs for details.",
    "reason.liveFromLibrary": "From your Stash library",
    "reason.notWatchedYet": "not watched yet",
    "reason.highRating": "High rating ({rating}/5)",
    "reason.ratingDays": "Rating {rating}/5 and not watched for {days} days",
    "reason.tags": "Tags: {tags}",
    "reason.studio": "Studio: {name}",
    "reason.rating": "Rating {rating}/5",
    "reason.plays": "{count} plays",
    "overlay.close": "Close Stash Cinematic",
    "mcpAgent.title": "MCP Agent",
    "mcpAgent.close": "Close MCP Agent",
    "mcpAgent.welcome":
      "Welcome to your local Stash agent. Scan the full library to build a cinematic-style index, then ask questions or search by title, tags, performers, and studios.",
    "mcpAgent.sidebarKicker": "Local index",
    "mcpAgent.sidebarTitle": "Agent library database",
    "mcpAgent.sidebarDescription":
      "Creates agent_library.db — a fast local copy of your Stash metadata for chat and MCP tools.",
    "mcpAgent.statScenes": "{count} scenes indexed",
    "mcpAgent.statTags": "{count} tags",
    "mcpAgent.statPerformers": "{count} performers",
    "mcpAgent.statStudios": "{count} studios",
    "mcpAgent.scanButton": "Scan full library",
    "mcpAgent.scanning": "Scanning library...",
    "mcpAgent.scanDone": "Library scan finished. You can chat with the agent now.",
    "mcpAgent.scanStarted": "Library scan started in the background. Job ID: {jobId}",
    "mcpAgent.scanFailed": "Library scan failed. Check the Stash plugin logs.",
    "mcpAgent.setupButton": "Install MCP dependencies",
    "mcpAgent.setupBusy": "Installing MCP dependencies...",
    "mcpAgent.indexMissing": "Run a full library scan before chatting.",
    "mcpAgent.indexReady": "Local agent index is ready.",
    "mcpAgent.bannerTitleWorking": "Setting up MCP agent",
    "mcpAgent.bannerTitleReady": "Setup complete",
    "mcpAgent.bannerTitleError": "Setup needs attention",
    "mcpAgent.bannerSubtitlePending": "Automatic setup is starting — this page updates live.",
    "mcpAgent.bannerSubtitleDeps": "Step 1/4: Installing Python packages (requests, mcp) on the Stash server…",
    "mcpAgent.bannerSubtitleSetup": "Step 2/4: MCP pip install into the plugin vendor/ folder…",
    "mcpAgent.bannerSubtitleIndex": "Step 4/4: Building agent_library.db from your library…",
    "mcpAgent.bannerSubtitleIndexWaiting":
      "Step 4/4: Library index not ready — check the log below or click “Scan full library”.",
    "mcpAgent.bannerSubtitleStale":
      "No progress for 20+ minutes — scan may be stuck. Check Stash → Settings → Tasks or restart the scan.",
    "mcpAgent.bannerSubtitleScan": "Step 4/4: Indexing scenes — {current} indexed so far",
    "mcpAgent.bannerSubtitleScanWithTotal": "Step 4/4: Indexing scenes — {current} of ~{total}",
    "mcpAgent.bannerSubtitleError": "A step failed. Use the buttons below or check the log under the chat.",
    "mcpAgent.bannerStarting": "Waiting for the Stash plugin task to start…",
    "mcpAgent.bannerCurrentError": "Setup failed — see details below.",
    "mcpAgent.bannerStepDeps": "Packages",
    "mcpAgent.bannerStepMcp": "MCP pip",
    "mcpAgent.bannerStepStashDb": "Stash DB",
    "mcpAgent.bannerStepIndex": "Library index",
    "mcpAgent.bannerLiveFeed": "Latest log lines",
    "mcpAgent.bannerScanOfTotal": "{current} / ~{total} scenes",
    "mcpAgent.bannerHint": "Everything runs on your Stash server. You can close this tab and come back — setup continues in the background.",
    "mcpAgent.statusTitle": "Setup status",
    "mcpAgent.statusLoading": "Loading status from server…",
    "mcpAgent.statusDeps": "Python packages (requests, mcp)",
    "mcpAgent.statusDepsOk": "Installed on Stash server",
    "mcpAgent.statusDepsMissing": "Installing automatically in the background (Stash plugin task)…",
    "mcpAgent.statusDepsMissingPython": "Installing via Stash ({python})…",
    "mcpAgent.statusDepsFailed": "Install failed: {error}",
    "mcpAgent.statusSetup": "MCP installation (pip)",
    "mcpAgent.statusSetupOk": "Completed",
    "mcpAgent.statusSetupPending": "Running in the background — no action needed",
    "mcpAgent.statusSetupFailedShort": "Install failed — use “Retry setup” or check Stash logs",
    "mcpAgent.statusSetupFailedDetail": "Install failed: {error}",
    "mcpAgent.statusIconOk": "Completed",
    "mcpAgent.statusIconPending": "Pending",
    "mcpAgent.statusIconFailed": "Failed",
    "mcpAgent.statusStashDbFailed": "Not readable at {path}: {error}",
    "mcpAgent.statusDbFailed": "Library scan failed — check plugin logs",
    "mcpAgent.activityTitle": "Activity",
    "mcpAgent.activityWorking": "Working…",
    "mcpAgent.activityJob": "Stash job #{jobId}",
    "mcpAgent.activityAutoSetup": "Starting automatic MCP install…",
    "mcpAgent.activityAutoSetupBackground": "MCP setup is running as a Stash background task…",
    "mcpAgent.autoSetupDone": "MCP dependencies are installed. You can scan the library or start chatting after the index is ready.",
    "mcpAgent.autoSetupBackgroundPending":
      "Setup is still running in the background. Watch the activity panel or Stash → Settings → Tasks. You can close this window and come back later.",
    "mcpAgent.autoSetupPartial":
      "Setup did not finish successfully. Use “Retry setup”. Detailed output is in the Stash log (systemd/journal or Stash → Settings → Logs → Trace), lines tagged [Plugin / Smart Dashboard…]. No terminal required.",
    "mcpAgent.autoScanStart": "Starting an automatic full library scan to build agent_library.db…",
    "mcpAgent.setupRetry": "Retry setup",
    "mcpAgent.activitySetupStart": "Starting MCP dependency install…",
    "mcpAgent.activitySetupRunning": "Installing Python packages (requests, mcp)…",
    "mcpAgent.activitySetupDone": "MCP install finished.",
    "mcpAgent.activitySetupFailed": "MCP install failed — see hint below for log output.",
    "mcpAgent.logsHint":
      "The log under the chat lists MCP setup, library index, recommendations, duplicate scan, and cleanup — tagged [MCP] or [Cinematic]. Running jobs: Stash → Settings → Tasks.",
    "mcpAgent.logTitle": "Log",
    "mcpAgent.logCopy": "Copy log",
    "mcpAgent.logCopyDone": "Log copied to clipboard.",
    "mcpAgent.logCopyFailed": "Could not copy. Select the text manually.",
    "mcpAgent.logEmpty":
      "No log entries yet. MCP and Cinematic tasks write here with tags [MCP] and [Cinematic] (updates every few seconds).",
    "mcpAgent.logWaiting": "Waiting for log output from the Stash server…\nCurrent step: {activity}",
    "mcpAgent.logRefresh": "Refresh log",
    "mcpAgent.activityScanStart": "Starting library scan…",
    "mcpAgent.activityScanRunning": "Building agent_library.db…",
    "mcpAgent.activityScanDone": "Library index is ready.",
    "mcpAgent.activityScanFailed": "Library scan failed — check plugin logs.",
    "mcpAgent.activityScanProgress": "{scenes} scenes indexed so far",
    "mcpAgent.statusDb": "Index database (agent_library.db)",
    "mcpAgent.statusDbOk": "Ready ({count} scenes)",
    "mcpAgent.statusDbEmpty": "Missing or empty — run “Scan full library”",
    "mcpAgent.statusDbSize": "File size: {size}",
    "mcpAgent.statusDbDate": "Last scan: {date}",
    "mcpAgent.statusStashDb": "Stash database (stash-go.sqlite)",
    "mcpAgent.statusStashDbOk": "Readable — {count} scenes in source DB",
    "mcpAgent.statusStashDbMissing": "Not found — scan uses GraphQL (slower)",
    "mcpAgent.statusStashDbPath": "Configured at {path} — not readable yet",
    "mcpAgent.statusStashDbUnreadable": "At {path} — not readable (locked or wrong file?)",
    "mcpAgent.indexSourceSqlite": "built from SQLite",
    "mcpAgent.externalHint":
      "External agents (Cursor, OpenClaw) can use stash_mcp_server.py with stash_agent_chat and stash_rebuild_agent_index.",
    "mcpAgent.connectTitle": "Connect your AI agent",
    "mcpAgent.connectStep1": "1. On first use, Stash installs MCP dependencies automatically in the background, then scans the library.",
    "mcpAgent.connectStep2": "2. Copy the MCP config below into your agent (Cursor, Claude Desktop, OpenClaw, …).",
    "mcpAgent.connectStep3":
      "3. API key and server path are filled in automatically from Stash (Settings → Security).",
    "mcpAgent.configLoading": "Loading MCP configuration…",
    "mcpAgent.connectStep4": "4. Restart the agent app and call stash_rebuild_agent_index if needed.",
    "mcpAgent.connectDoc": "Full guide: README.md → Agent integration → MCP (on GitHub).",
    "mcpAgent.copyConfig": "Copy MCP config",
    "mcpAgent.copyConfigDone": "Copied to clipboard.",
    "mcpAgent.copyConfigFailed": "Could not copy. Select the JSON manually.",
    "mcpAgent.inputPlaceholder": "Ask the agent, e.g. stats, tag name, performer, or scene title...",
    "mcpAgent.inputDisabled": "Scan the library first...",
    "mcpAgent.send": "Send",
    "mcpAgent.thinking": "Searching the local index...",
    "mcpAgent.resultsTitle": "Matching scenes",
    "mcpAgent.chatFailed": "Agent request failed. Check the Stash plugin logs.",
    "mcpAgent.noReply": "No reply from the agent.",
  };

  const DE_FLAT = {
    "nav.cinematic": "Cinematic",
    "nav.mcp_server": "MCP-Server",
    "app.title": "Stash Cinematic",
    "app.brand": "Stash",
    "hero.featured": "Empfohlene Szene",
    "hero.play": "Abspielen",
    "hero.refresh": "Aktualisieren",
    "hero.defaultDescription": "Eine herausragende Empfehlung aus deiner lokalen Stash-Bibliothek.",
    "hero.generateHint": "Erzeuge Empfehlungen, um dein Cinematic-Dashboard freizuschalten.",
    "row.library_spotlight.title": "Bibliotheks-Spotlight",
    "row.library_spotlight.subtitle": "Eine zuverlässige Auswahl aus deiner lokalen Szenen-Bibliothek.",
    "row.forgotten_gems.title": "Vergessene Perlen",
    "row.forgotten_gems.subtitle": "Hoch bewertete Szenen, die ein Comeback verdienen.",
    "row.top_rated.title": "Top bewertet",
    "row.top_rated.subtitle": "Die bestbewerteten Szenen in deiner Bibliothek.",
    "row.recently_watched.title": "Zuletzt angesehen",
    "row.recently_watched.subtitle": "Setze die Stimmung deiner letzten Sessions fort.",
    "row.smart_suggestions.title": "Smarte Vorschläge",
    "row.smart_suggestions.subtitle": "Aus Bewertungen, Tags, Studios und Wiedergabeverlauf.",
    "row.scenesCount": "{count} Szenen",
    "row.scrollLeft": "{title} nach links scrollen",
    "row.scrollRight": "{title} nach rechts scrollen",
    "random.title": "Zufallsauswahl",
    "random.subtitle": "Sechs zufällige Videos aus deiner gesamten Stash-Bibliothek.",
    "random.refresh": "Neu mischen",
    "random.loading": "Lädt...",
    "search.kicker": "Suche",
    "search.title": "Cinematic-Suche",
    "search.description": "Durchsuche die gesamte Stash-Bibliothek nach Titel, Dateiname oder Tags.",
    "search.titleLabel": "Titel oder Dateiname",
    "search.tagsLabel": "Tags (kommagetrennt)",
    "search.titlePlaceholder": "Szenentitel oder Dateiname",
    "search.tagsPlaceholder": "Tag, weiterer Tag",
    "search.button": "Bibliothek durchsuchen",
    "search.searching": "Suche läuft...",
    "search.error.empty": "Gib einen Titel, Dateinamen oder Tag ein.",
    "search.info.searching": "Durchsuche die gesamte Stash-Bibliothek...",
    "search.noResults": "Keine passenden Szenen gefunden.",
    "search.results.title": "Suchergebnisse",
    "search.results.subtitle": "{count} Treffer in deiner Stash-Bibliothek.",
    "search.results.subtitle_plural": "{count} Treffer in deiner Stash-Bibliothek.",
    "player.nowPlaying": "Wird abgespielt",
    "player.openInStash": "In Stash öffnen",
    "player.close": "Player schließen",
    "card.openInStash": "In Stash öffnen",
    "card.plays": "{count} Wiedergaben",
    "card.unrated": "Unbewertet",
    "stats.videos": "Videos in Stash",
    "stats.estimated": "Geschätzte Erstellungszeit",
    "stats.spotlight": "Bibliotheks-Spotlight",
    "stats.suggestions": "Smarte Vorschläge",
    "topTags.title": "Aus deinen Top-Tags",
    "topTags.subtitle": "Priorisiert nach: {tags}",
    "loading.cinematic": "Stash Cinematic wird geladen...",
    "empty.noRows": "Noch keine Empfehlungsreihen",
    "empty.noRowsHint": "Klicke oben auf „Empfehlungen aktualisieren“, um die Reihen neu zu erstellen.",
    "error.recommendationsNotFound": "recommendations.json nicht gefunden",
    "error.recommendationsHint":
      "Klicke auf „Empfehlungen aktualisieren“, um die Cinematic-Reihen neu zu erstellen. Bibliotheks-Tools bleiben verfügbar.",
    "error.reportUnavailable": "Der lokale Bericht ist nicht verfügbar. Prüfe die Stash-Logs.",
    "topbar.libraryTools": "Bibliotheks-Tools verfügbar",
    "topbar.refresh": "Empfehlungen aktualisieren",
    "topbar.refreshBusy": "Arbeitet...",
    "topbar.uiMeta": "UI {version} • Aktualisiert {date} • {count} Videos • ca. {duration}{extra}",
    "topbar.uiMetaNoDate": "UI {version} • {count} Videos • ca. {duration}{extra}",
    "topbar.autostart": " • Empfehlungen gestartet (~{duration})",
    "refresh.rebuilding": "Empfehlungen werden neu erstellt...",
    "refresh.jobStarted":
      "Empfehlungen als Hintergrundjob gestartet. Job-ID: {jobId}. Nach Abschluss neu laden.",
    "refresh.done": "Empfehlungen wurden neu erstellt und geladen.",
    "refresh.failed": "Empfehlungen konnten nicht neu erstellt werden. Prüfe die Stash-Logs.",
    "tasks.kicker": "Plugin-Aufgaben",
    "tasks.title": "Aufgaben in Cinematic",
    "tasks.description":
      "Setup startet automatisch beim ersten Öffnen von Cinematic. Du kannst alle wichtigen Aufgaben auch manuell starten.",
    "tasks.setup.title": "Setup",
    "tasks.setup.description": "Installiert oder aktualisiert Python-Abhängigkeiten.",
    "tasks.setup.button": "Setup starten",
    "tasks.setup.autoStarted": "Automatisches Setup gestartet. Job-ID: {jobId}",
    "tasks.setup.autoDone": "Automatisches Setup direkt abgeschlossen.",
    "tasks.setup.autoFailed": "Automatisches Setup konnte nicht gestartet werden. Prüfe die Stash-Logs.",
    "tasks.setup.already": "Setup wurde in diesem Browser bereits gestartet.",
    "tasks.recommendations.title": "Empfehlungen",
    "tasks.recommendations.description": "Erstellt recommendations.json für Cinematic neu.",
    "tasks.recommendations.button": "Empfehlungen aktualisieren",
    "tasks.recommendations.autostart": "Automatisch gestartet.",
    "tasks.duplicates.title": "Duplikat-Scan",
    "tasks.duplicates.description": "Startet den visuellen pHash-Duplikat-Scan.",
    "tasks.duplicates.button": "Duplikat-Scan starten",
    "tasks.starting": "Aufgabe wird gestartet...",
    "tasks.started": "Gestartet. Job-ID: {jobId}",
    "tasks.done": "Direkt abgeschlossen. Bericht oder Dashboard danach neu laden.",
    "tasks.failed": "Konnte nicht gestartet werden. Prüfe die Stash-Logs.",
    "duplicates.kicker": "Duplikat-Ergebnisse",
    "duplicates.title": "Duplikat-Scan-Ergebnisse",
    "duplicates.description":
      "Kandidaten aus duplicates_report.json erscheinen hier nach dem Duplikat-Scan.",
    "duplicates.reload": "Bericht neu laden",
    "duplicates.loading": "Duplikat-Bericht wird geladen...",
    "duplicates.empty": "Noch kein Duplikat-Bericht vorhanden.",
    "duplicates.emptyHint": "Starte den Duplikat-Scan in Cinematic und lade dann den Bericht neu.",
    "duplicates.candidates": "Kandidaten: {count}",
    "duplicates.hashed": "Gehasht: {done}/{total}",
    "duplicates.cache": "Cache: {count}",
    "duplicates.skipped": "Übersprungen: {count}",
    "duplicates.updated": "Aktualisiert: {date}",
    "duplicates.none": "Keine Duplikat-Kandidaten im letzten Bericht.",
    "duplicates.distance": "Distanz {value}",
    "cleanup.kicker": "Bibliotheks-Tools",
    "cleanup.title": "Kurzvideo-Bereinigung",
    "cleanup.description":
      "Entfernt Szenen unter einer Dauer aus Stash. Die Originaldateien bleiben auf der Festplatte.",
    "cleanup.label": "Videos kürzer als (Minuten:Sekunden) löschen:",
    "cleanup.hint": "Szenen unter dieser Dauer werden nur aus Stash entfernt.",
    "cleanup.placeholder": "0:30 oder 90",
    "cleanup.purge": "Bereinigen",
    "cleanup.purging": "Startet...",
    "cleanup.warning":
      "Nur Stash-Bereinigung: passende Szenen werden mit sceneDestroy(delete_file: false) entfernt. Beispiele: 0:30, 1:15, 90.",
    "cleanup.confirm":
      "Alle Szenen kürzer als {seconds} Sekunden ({input}) werden nur aus Stash entfernt.\n\nDie Originaldateien bleiben auf der Festplatte. Betroffene Szenen erscheinen nicht mehr in Stash.\n\nFortfahren?",
    "cleanup.invalid": "Bitte eine gültige Dauer eingeben, z. B. 0:30, 1:15 oder 90.",
    "cleanup.running": "Bereinigung läuft...",
    "cleanup.done": "Bereinigung abgeschlossen. Details in den Stash-Logs.",
    "cleanup.failed": "Bereinigung konnte nicht gestartet werden. Prüfe die Stash-Logs.",
    "mcp.installing": "MCP-Agent-Abhängigkeiten werden installiert (requirements-agent.txt)...",
    "mcp.started": "MCP-Installation gestartet. Job-ID: {jobId}. Pip-Ausgabe in den Stash-Logs.",
    "mcp.done": "MCP-Abhängigkeiten installiert. stash_mcp_server.py in der MCP-Client-Konfiguration eintragen.",
    "mcp.failed": "MCP-Installation fehlgeschlagen. Prüfe die Plugin-Logs.",
    "reason.liveFromLibrary": "Aus deiner Stash-Bibliothek",
    "reason.notWatchedYet": "noch nicht angesehen",
    "reason.highRating": "Hohe Bewertung ({rating}/5)",
    "reason.ratingDays": "Bewertung {rating}/5 und seit {days} Tagen nicht gesehen",
    "reason.tags": "Tags: {tags}",
    "reason.studio": "Studio: {name}",
    "reason.rating": "Bewertung {rating}/5",
    "reason.plays": "{count} Wiedergaben",
    "overlay.close": "Stash Cinematic schließen",
    "mcpAgent.title": "MCP-Agent",
    "mcpAgent.close": "MCP-Agent schließen",
    "mcpAgent.welcome":
      "Willkommen beim lokalen Stash-Agenten. Scanne die gesamte Bibliothek für einen Cinematic-Index und stelle dann Fragen zu Titeln, Tags, Darstellern und Studios.",
    "mcpAgent.sidebarKicker": "Lokaler Index",
    "mcpAgent.sidebarTitle": "Agent-Bibliotheksdatenbank",
    "mcpAgent.sidebarDescription":
      "Erstellt agent_library.db — eine schnelle lokale Kopie deiner Stash-Metadaten für Chat und MCP-Tools.",
    "mcpAgent.statScenes": "{count} Szenen indexiert",
    "mcpAgent.statTags": "{count} Tags",
    "mcpAgent.statPerformers": "{count} Darsteller",
    "mcpAgent.statStudios": "{count} Studios",
    "mcpAgent.scanButton": "Gesamte Bibliothek scannen",
    "mcpAgent.scanning": "Bibliothek wird gescannt...",
    "mcpAgent.scanDone": "Bibliotheks-Scan abgeschlossen. Du kannst jetzt mit dem Agenten chatten.",
    "mcpAgent.scanStarted": "Bibliotheks-Scan im Hintergrund gestartet. Job-ID: {jobId}",
    "mcpAgent.scanFailed": "Bibliotheks-Scan fehlgeschlagen. Prüfe die Plugin-Logs.",
    "mcpAgent.setupButton": "MCP-Abhängigkeiten installieren",
    "mcpAgent.setupBusy": "MCP-Abhängigkeiten werden installiert...",
    "mcpAgent.indexMissing": "Zuerst die Bibliothek scannen, dann chatten.",
    "mcpAgent.indexReady": "Lokaler Agent-Index ist bereit.",
    "mcpAgent.bannerTitleWorking": "MCP-Agent wird eingerichtet",
    "mcpAgent.bannerTitleReady": "Einrichtung abgeschlossen",
    "mcpAgent.bannerTitleError": "Einrichtung braucht Aufmerksamkeit",
    "mcpAgent.bannerSubtitlePending": "Automatische Einrichtung startet — diese Seite aktualisiert sich live.",
    "mcpAgent.bannerSubtitleDeps": "Schritt 1/4: Python-Pakete (requests, mcp) auf dem Stash-Server installieren …",
    "mcpAgent.bannerSubtitleSetup": "Schritt 2/4: MCP pip-Installation in vendor/ …",
    "mcpAgent.bannerSubtitleIndex": "Schritt 4/4: agent_library.db aus deiner Bibliothek aufbauen …",
    "mcpAgent.bannerSubtitleIndexWaiting":
      "Schritt 4/4: Index noch nicht bereit — Log unten prüfen oder „Gesamte Bibliothek scannen“.",
    "mcpAgent.bannerSubtitleStale":
      "Seit 20+ Minuten keine Fortschrittsmeldung — Scan evtl. hängengeblieben. Stash → Einstellungen → Tasks prüfen oder Scan neu starten.",
    "mcpAgent.bannerSubtitleScan": "Schritt 4/4: Szenen indexieren — bisher {current}",
    "mcpAgent.bannerSubtitleScanWithTotal": "Schritt 4/4: Szenen indexieren — {current} von ~{total}",
    "mcpAgent.bannerSubtitleError": "Ein Schritt ist fehlgeschlagen. Buttons unten oder Log unter dem Chat.",
    "mcpAgent.bannerStarting": "Warte auf Start des Stash-Plugin-Tasks …",
    "mcpAgent.bannerCurrentError": "Einrichtung fehlgeschlagen — Details unten.",
    "mcpAgent.bannerStepDeps": "Pakete",
    "mcpAgent.bannerStepMcp": "MCP pip",
    "mcpAgent.bannerStepStashDb": "Stash-DB",
    "mcpAgent.bannerStepIndex": "Bibliotheks-Index",
    "mcpAgent.bannerLiveFeed": "Letzte Log-Zeilen",
    "mcpAgent.bannerScanOfTotal": "{current} / ~{total} Szenen",
    "mcpAgent.bannerHint":
      "Alles läuft auf deinem Stash-Server. Tab schließen ist ok — die Einrichtung läuft im Hintergrund weiter.",
    "mcpAgent.statusTitle": "Einrichtungsstatus",
    "mcpAgent.statusLoading": "Status wird vom Server geladen…",
    "mcpAgent.statusDeps": "Python-Pakete (requests, mcp)",
    "mcpAgent.statusDepsOk": "Auf dem Stash-Server installiert",
    "mcpAgent.statusDepsMissing": "Wird automatisch im Hintergrund installiert (Stash-Plugin-Task)…",
    "mcpAgent.statusDepsMissingPython": "Installation über Stash ({python})…",
    "mcpAgent.statusDepsFailed": "Installation fehlgeschlagen: {error}",
    "mcpAgent.statusSetup": "MCP-Installation (pip)",
    "mcpAgent.statusSetupOk": "Abgeschlossen",
    "mcpAgent.statusSetupPending": "Läuft im Hintergrund — nichts tun nötig",
    "mcpAgent.statusSetupFailedShort": "Installation fehlgeschlagen — „Installation erneut starten“ oder Stash-Logs prüfen",
    "mcpAgent.statusSetupFailedDetail": "Installation fehlgeschlagen: {error}",
    "mcpAgent.statusIconOk": "Abgeschlossen",
    "mcpAgent.statusIconPending": "Ausstehend",
    "mcpAgent.statusIconFailed": "Fehlgeschlagen",
    "mcpAgent.statusStashDbFailed": "Nicht lesbar unter {path}: {error}",
    "mcpAgent.statusDbFailed": "Bibliotheks-Scan fehlgeschlagen — Plugin-Logs prüfen",
    "mcpAgent.activityTitle": "Aktivität",
    "mcpAgent.activityWorking": "Läuft…",
    "mcpAgent.activityJob": "Stash-Job #{jobId}",
    "mcpAgent.activityAutoSetup": "Automatische MCP-Installation wird gestartet…",
    "mcpAgent.activityAutoSetupBackground": "MCP-Einrichtung läuft als Stash-Hintergrundtask…",
    "mcpAgent.autoSetupDone": "MCP-Abhängigkeiten sind installiert. Bibliothek scannen oder chatten, sobald der Index bereit ist.",
    "mcpAgent.autoSetupBackgroundPending":
      "Die Einrichtung läuft noch im Hintergrund. Aktivitätsfeld oder Stash → Einstellungen → Tasks beobachten. Fenster kann geschlossen werden.",
    "mcpAgent.autoSetupPartial":
      "Einrichtung nicht erfolgreich. „Installation erneut starten“. Details im Stash-Log (journalctl -u stash -f oder Einstellungen → Logs → Trace), Zeilen [Plugin / Smart Dashboard…]. Kein Terminal nötig.",
    "mcpAgent.autoScanStart": "Automatischer Bibliotheks-Scan wird gestartet (agent_library.db)…",
    "mcpAgent.setupRetry": "Installation erneut starten",
    "mcpAgent.activitySetupStart": "MCP-Installation wird gestartet…",
    "mcpAgent.activitySetupRunning": "Python-Pakete werden installiert (requests, mcp)…",
    "mcpAgent.activitySetupDone": "MCP-Installation abgeschlossen.",
    "mcpAgent.activitySetupFailed": "MCP-Installation fehlgeschlagen — Hinweis unten zu Log-Ausgabe.",
    "mcpAgent.logsHint":
      "Das Log unter dem Chat zeigt MCP-Einrichtung, Index, Empfehlungen, Duplikat-Scan und Cleanup — mit [MCP] oder [Cinematic]. Laufende Jobs: Stash → Einstellungen → Tasks.",
    "mcpAgent.logTitle": "Log",
    "mcpAgent.logCopy": "Log kopieren",
    "mcpAgent.logCopyDone": "Log in die Zwischenablage kopiert.",
    "mcpAgent.logCopyFailed": "Kopieren fehlgeschlagen — Text manuell markieren.",
    "mcpAgent.logEmpty":
      "Noch keine Log-Einträge. MCP- und Cinematic-Tasks schreiben hier mit [MCP] bzw. [Cinematic] (aktualisiert sich alle paar Sekunden).",
    "mcpAgent.logWaiting": "Warte auf Log-Ausgabe vom Stash-Server…\nAktueller Schritt: {activity}",
    "mcpAgent.logRefresh": "Log aktualisieren",
    "mcpAgent.activityScanStart": "Bibliotheks-Scan wird gestartet…",
    "mcpAgent.activityScanRunning": "agent_library.db wird aufgebaut…",
    "mcpAgent.activityScanDone": "Bibliotheks-Index ist bereit.",
    "mcpAgent.activityScanFailed": "Bibliotheks-Scan fehlgeschlagen — Plugin-Logs prüfen.",
    "mcpAgent.activityScanProgress": "Bisher {scenes} Szenen indexiert",
    "mcpAgent.statusDb": "Index-Datenbank (agent_library.db)",
    "mcpAgent.statusDbOk": "Bereit ({count} Szenen)",
    "mcpAgent.statusDbEmpty": "Fehlt oder leer — „Gesamte Bibliothek scannen“",
    "mcpAgent.statusDbSize": "Dateigröße: {size}",
    "mcpAgent.statusDbDate": "Letzter Scan: {date}",
    "mcpAgent.statusStashDb": "Stash-Datenbank (stash-go.sqlite)",
    "mcpAgent.statusStashDbOk": "Lesbar — {count} Szenen in der Quell-DB",
    "mcpAgent.statusStashDbMissing": "Nicht gefunden — Scan nutzt GraphQL (langsamer)",
    "mcpAgent.statusStashDbPath": "Konfiguriert: {path} — noch nicht lesbar",
    "mcpAgent.statusStashDbUnreadable": "Unter {path} — nicht lesbar (gesperrt oder falsche Datei?)",
    "mcpAgent.indexSourceSqlite": "aus SQLite gebaut",
    "mcpAgent.externalHint":
      "Externe Agenten (Cursor, OpenClaw) nutzen stash_mcp_server.py mit stash_agent_chat und stash_rebuild_agent_index.",
    "mcpAgent.connectTitle": "KI-Agent verbinden",
    "mcpAgent.connectStep1": "1. Beim ersten Mal installiert Stash die MCP-Abhängigkeiten automatisch im Hintergrund und scannt die Bibliothek.",
    "mcpAgent.connectStep2": "2. MCP-Konfiguration unten in deinen Agent kopieren (Cursor, Claude Desktop, OpenClaw, …).",
    "mcpAgent.connectStep3":
      "3. API-Key und Server-Pfad werden automatisch aus Stash übernommen (Einstellungen → Sicherheit).",
    "mcpAgent.configLoading": "MCP-Konfiguration wird geladen…",
    "mcpAgent.connectStep4": "4. Agent-App neu starten; bei Bedarf stash_rebuild_agent_index aufrufen.",
    "mcpAgent.connectDoc": "Ausführliche Anleitung: README.md → Agent integration → MCP (auf GitHub).",
    "mcpAgent.copyConfig": "MCP-Config kopieren",
    "mcpAgent.copyConfigDone": "In die Zwischenablage kopiert.",
    "mcpAgent.copyConfigFailed": "Kopieren fehlgeschlagen. JSON manuell markieren.",
    "mcpAgent.inputPlaceholder": "Frage stellen, z. B. Statistik, Tag, Darsteller oder Titel...",
    "mcpAgent.inputDisabled": "Zuerst Bibliothek scannen...",
    "mcpAgent.send": "Senden",
    "mcpAgent.thinking": "Durchsuche den lokalen Index...",
    "mcpAgent.resultsTitle": "Passende Szenen",
    "mcpAgent.chatFailed": "Agent-Anfrage fehlgeschlagen. Prüfe die Plugin-Logs.",
    "mcpAgent.noReply": "Keine Antwort vom Agenten.",
  };

  const FR_FLAT = Object.assign({}, EN_FLAT, {
    "nav.cinematic": "Cinéma",
    "nav.mcp_server": "Serveur MCP",
    "hero.featured": "Scène à la une",
    "hero.play": "Lire",
    "search.title": "Recherche cinéma",
    "player.openInStash": "Ouvrir dans Stash",
    "tasks.setup.button": "Lancer l'installation",
    "mcp.installing": "Installation des dépendances MCP...",
  });

  const ES_FLAT = Object.assign({}, EN_FLAT, {
    "nav.cinematic": "Cinematic",
    "hero.play": "Reproducir",
    "search.title": "Búsqueda cinematic",
    "player.openInStash": "Abrir en Stash",
    "tasks.setup.button": "Iniciar configuración",
  });

  const JA_FLAT = Object.assign({}, EN_FLAT, {
    "nav.cinematic": "シネマ",
    "nav.mcp_server": "MCPサーバー",
    "hero.play": "再生",
    "search.title": "シネマ検索",
    "player.openInStash": "Stashで開く",
    "loading.cinematic": "Stash Cinematic を読み込み中...",
  });

  const ZH_FLAT = Object.assign({}, EN_FLAT, {
    "nav.cinematic": "影院",
    "nav.mcp_server": "MCP 服务器",
    "hero.play": "播放",
    "search.title": "影院搜索",
    "player.openInStash": "在 Stash 中打开",
    "loading.cinematic": "正在加载 Stash Cinematic...",
  });

  const ZH_TW_FLAT = Object.assign({}, ZH_FLAT, {
    "nav.cinematic": "影院",
    "nav.mcp_server": "MCP 伺服器",
    "hero.play": "播放",
    "player.openInStash": "在 Stash 中開啟",
  });

  const CATALOGS = {
    en: EN_FLAT,
    de: DE_FLAT,
    fr: FR_FLAT,
    es: ES_FLAT,
    it: Object.assign({}, EN_FLAT, { "hero.play": "Riproduci", "player.openInStash": "Apri in Stash" }),
    ja: JA_FLAT,
    ko: Object.assign({}, EN_FLAT, { "hero.play": "재생", "player.openInStash": "Stash에서 열기" }),
    nl: Object.assign({}, EN_FLAT, { "hero.play": "Afspelen", "player.openInStash": "Openen in Stash" }),
    pl: Object.assign({}, EN_FLAT, { "hero.play": "Odtwórz", "player.openInStash": "Otwórz w Stash" }),
    pt: Object.assign({}, EN_FLAT, { "hero.play": "Reproduzir", "player.openInStash": "Abrir no Stash" }),
    ru: Object.assign({}, EN_FLAT, { "hero.play": "Воспроизвести", "player.openInStash": "Открыть в Stash" }),
    tr: Object.assign({}, EN_FLAT, { "hero.play": "Oynat", "player.openInStash": "Stash'te aç" }),
    uk: Object.assign({}, EN_FLAT, { "hero.play": "Відтворити", "player.openInStash": "Відкрити в Stash" }),
    zh: ZH_FLAT,
    "zh-tw": ZH_TW_FLAT,
    "zh-hk": ZH_TW_FLAT,
  };

  function normalizeLocale(language) {
    if (!language) {
      return "en";
    }
    const raw = String(language).trim().toLowerCase().replace(/_/g, "-");
    if (CATALOGS[raw]) {
      return raw;
    }
    if (raw.startsWith("zh")) {
      if (raw.includes("tw") || raw.includes("hk") || raw.includes("hant")) {
        return "zh-tw";
      }
      return "zh";
    }
    const base = raw.split("-")[0];
    if (CATALOGS[base]) {
      return base;
    }
    return "en";
  }

  function interpolate(template, params) {
    if (!template) {
      return "";
    }
    const values = params || {};
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    );
  }

  const state = {
    locale: "en",
    stashLanguage: "en-GB",
    ready: false,
    listeners: [],
  };

  function catalogFor(locale) {
    return CATALOGS[locale] || CATALOGS.en;
  }

  function t(key, params) {
    const catalog = catalogFor(state.locale);
    const template = catalog[key] || CATALOGS.en[key] || key;
    return interpolate(template, params);
  }

  function translateReason(value) {
    if (!value) {
      return "";
    }
    const text = String(value);
    const patterns = [
      [/^From your Stash library$/i, "reason.liveFromLibrary"],
      [/^Aus deiner Stash-Bibliothek$/i, "reason.liveFromLibrary"],
      [/^not watched yet$/i, "reason.notWatchedYet"],
      [/^noch nicht angesehen$/i, "reason.notWatchedYet"],
      [/^High rating \(([\d.]+)\/5\)$/i, (match) => t("reason.highRating", { rating: match[1] })],
      [/^Hohe Bewertung \(([\d.]+)\/5\)$/i, (match) => t("reason.highRating", { rating: match[1] })],
      [
        /^Rating ([\d.]+)\/5 and not watched for (\d+) days$/i,
        (match) => t("reason.ratingDays", { rating: match[1], days: match[2] }),
      ],
      [
        /^Bewertung ([\d.]+)\/5 und seit (\d+) Tagen nicht gesehen$/i,
        (match) => t("reason.ratingDays", { rating: match[1], days: match[2] }),
      ],
      [/^Tags: (.+)$/i, (match) => t("reason.tags", { tags: match[1] })],
      [/^Studio: (.+)$/i, (match) => t("reason.studio", { name: match[1] })],
      [/^Rating ([\d.]+)\/5$/i, (match) => t("reason.rating", { rating: match[1] })],
      [/^Bewertung ([\d.]+)\/5$/i, (match) => t("reason.rating", { rating: match[1] })],
      [/^(\d+) plays$/i, (match) => t("reason.plays", { count: match[1] })],
      [/^(\d+) Wiedergaben$/i, (match) => t("reason.plays", { count: match[1] })],
    ];

    for (const entry of patterns) {
      const match = text.match(entry[0]);
      if (match) {
        if (typeof entry[1] === "function") {
          return entry[1](match);
        }
        return t(entry[1]);
      }
    }

    return text
      .split("; ")
      .map((part) => {
        for (const entry of patterns) {
          const match = part.match(entry[0]);
          if (match) {
            if (typeof entry[1] === "function") {
              return entry[1](match);
            }
            return t(entry[1]);
          }
        }
        return part;
      })
      .join("; ");
  }

  async function fetchStashLanguage(getGraphqlUrl) {
    const graphqlUrl = typeof getGraphqlUrl === "function" ? getGraphqlUrl() : getGraphqlUrl;
    if (!graphqlUrl) {
      return null;
    }

    const query = `
      query SmartDashboardInterfaceLanguage {
        configuration {
          interface {
            language
          }
        }
      }
    `;

    try {
      const response = await fetch(graphqlUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json();
      return payload?.data?.configuration?.interface?.language || null;
    } catch (_error) {
      return null;
    }
  }

  function applyDocumentLanguage(locale) {
    if (document.documentElement) {
      document.documentElement.lang = locale === "zh-tw" ? "zh-TW" : locale;
    }
  }

  function setLocale(language, notify) {
    state.stashLanguage = language || state.stashLanguage;
    state.locale = normalizeLocale(language || state.stashLanguage);
    applyDocumentLanguage(state.locale);
    if (notify) {
      state.listeners.forEach((listener) => {
        try {
          listener(state.locale);
        } catch (_error) {
          /* ignore */
        }
      });
    }
  }

  async function init(options) {
    const browserLanguage = window.navigator?.language;
    const stashLanguage = (await fetchStashLanguage(options?.getGraphqlUrl)) || browserLanguage || "en-GB";
    setLocale(stashLanguage, false);
    state.ready = true;
    state.listeners.forEach((listener) => {
      try {
        listener(state.locale);
      } catch (_error) {
        /* ignore */
      }
    });
    return state.locale;
  }

  function onChange(listener) {
    state.listeners.push(listener);
    if (state.ready) {
      listener(state.locale);
    }
  }

  window.SmartDashboardI18n = {
    init,
    t,
    translateReason,
    getLocale: () => state.locale,
    getStashLanguage: () => state.stashLanguage,
    onChange,
    refresh: init,
    flatten,
    nest,
  };
})();
