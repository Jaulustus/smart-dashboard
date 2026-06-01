(function () {
  "use strict";

  const PLUGIN_ID = "smart_dashboard";
  const UI_VERSION = "0.2.0";
  const DASHBOARD_QUERY = "smart_dashboard=cinematic";
  const MCP_DASHBOARD_QUERY = "smart_dashboard=mcp";
  const SETUP_MODE = "setup";
  const SETUP_AGENT_MODE = "setup_agent";
  const BUILD_AGENT_INDEX_MODE = "build_agent_index";
  const AGENT_QUERY_MODE = "agent_query";
  const AGENT_INDEX_STATS_MODE = "agent_index_stats";
  const MCP_SETUP_KEY = "smart_dashboard_mcp_setup_done";
  const RECOMMENDATIONS_MODE = "smart_dash_calc";
  const DUP_SCAN_MODE = "smart_dup_scan";
  const RECOMMENDATIONS_AUTOSTART_KEY = "smart_dashboard_recommendations_autostarted";
  const RECOMMENDATIONS_MISSING_KEY = "smart_dashboard_recommendations_missing_at";
  const RECOMMENDATIONS_MISSING_TTL_MS = 30000;
  const DUPLICATES_MISSING_KEY = "smart_dashboard_duplicates_missing_at";
  const DUPLICATES_MISSING_TTL_MS = 30000;
  const SETUP_AUTOSTART_KEY = "smart_dashboard_setup_autostarted";
  const MAX_REGISTER_ATTEMPTS = 80;
  let registerAttempts = 0;
  let librarySearchCache = null;

  function t(key, params) {
    if (global.SmartDashboardI18n && typeof global.SmartDashboardI18n.t === "function") {
      return global.SmartDashboardI18n.t(key, params);
    }
    return key;
  }

  function pluginLanguage() {
    if (global.SmartDashboardI18n) {
      return global.SmartDashboardI18n.getStashLanguage() || global.SmartDashboardI18n.getLocale() || "en-GB";
    }
    return "en-GB";
  }

  function pluginBasePath() {
    const scripts = Array.from(document.scripts);
    const script = scripts.find((item) => item.src.includes(`/plugin/${PLUGIN_ID}/`));
    if (!script || !script.src) {
      return "";
    }

    try {
      const url = new URL(script.src);
      return url.pathname.split(`/plugin/${PLUGIN_ID}/`)[0] || "";
    } catch (_error) {
      return "";
    }
  }

  function assetUrl(fileName) {
    return `${pluginBasePath()}/plugin/${PLUGIN_ID}/assets/${fileName}`;
  }

  function assetCandidates(fileName, cacheBust) {
    return Array.from(new Set([
      `${assetUrl(fileName)}?${cacheBust}`,
      `/plugin/${PLUGIN_ID}/assets/${fileName}?${cacheBust}`,
    ]));
  }

  function openRoute() {
    if (typeof window.smartDashboardOpen === "function") {
      window.smartDashboardOpen();
      return;
    }

    window.history.pushState({}, "", `${pluginBasePath()}/?${DASHBOARD_QUERY}`);
  }

  function handleDashboardDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("smart_dashboard");
    if (mode === "mcp" && typeof window.smartDashboardMcpOpen === "function") {
      window.smartDashboardMcpOpen();
      return;
    }
    if (mode === "cinematic") {
      window.smartDashboardOpen();
    }
  }

  function normalizePluginResult(raw) {
    if (!raw) {
      return null;
    }
    let value = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_error) {
        return { reply: value };
      }
    }
    if (value.result && typeof value.result === "object") {
      return value.result;
    }
    if (value.reply || value.scenes || value.index) {
      return value;
    }
    if (value.output) {
      return { reply: value.output, ...value };
    }
    return value;
  }

  async function fetchAgentIndexStats() {
    const raw = await runPluginModeOperation(AGENT_INDEX_STATS_MODE, {});
    return normalizePluginResult(raw);
  }

  async function sendAgentChatMessage(message) {
    const raw = await runPluginModeOperation(AGENT_QUERY_MODE, { message });
    return normalizePluginResult(raw);
  }

  function openMcpRoute() {
    if (typeof window.smartDashboardMcpOpen === "function") {
      window.smartDashboardMcpOpen();
      return;
    }
    window.history.pushState({}, "", `${pluginBasePath()}/?${MCP_DASHBOARD_QUERY}`);
  }

  function buildMcpConfigSnippet() {
    const graphqlUrl = `${window.location.origin.replace(/\/$/, "")}/graphql`;
    const placeholderPath = "C:/stash/plugins/local/smart-dashboard/stash_mcp_server.py";
    return JSON.stringify(
      {
        mcpServers: {
          stash: {
            command: "python",
            args: [placeholderPath],
            env: {
              STASH_GRAPHQL_URL: graphqlUrl,
              STASH_API_KEY: "",
            },
          },
        },
      },
      null,
      2
    );
  }

  async function copyMcpConfigSnippet() {
    const text = buildMcpConfigSnippet();
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function shouldSkipMissingRecommendationsFetch() {
    const missingAt = Number(sessionStorage.getItem(RECOMMENDATIONS_MISSING_KEY) || 0);
    return missingAt > 0 && Date.now() - missingAt < RECOMMENDATIONS_MISSING_TTL_MS;
  }

  function shouldSkipMissingDuplicatesFetch() {
    const missingAt = Number(sessionStorage.getItem(DUPLICATES_MISSING_KEY) || 0);
    return missingAt > 0 && Date.now() - missingAt < DUPLICATES_MISSING_TTL_MS;
  }

  async function fetchRecommendations(options) {
    const forceAssetFetch = Boolean(options && options.forceAssetFetch);
    const cacheBust = `t=${Date.now()}`;
    const candidates = assetCandidates("recommendations.json", cacheBust);

    let lastError = null;
    if (forceAssetFetch || !shouldSkipMissingRecommendationsFetch()) {
      for (const url of candidates) {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const data = await response.json();
          sessionStorage.removeItem(RECOMMENDATIONS_MISSING_KEY);
          return enrichSceneTitles(data);
        } catch (error) {
          lastError = error;
        }
      }

      sessionStorage.setItem(RECOMMENDATIONS_MISSING_KEY, String(Date.now()));
    }

    console.warn("[Smart Dashboard] recommendations.json not available, using GraphQL fallback", lastError);
    const fallback = await buildRecommendationsFromGraphQL();
    fallback.recommendations_autostart = { started: false, reason: "manual_refresh_required" };
    return fallback;
  }

  async function fetchDuplicateReport(options) {
    const forceAssetFetch = Boolean(options && options.forceAssetFetch);
    if (!forceAssetFetch && shouldSkipMissingDuplicatesFetch()) {
      throw new Error("duplicates_report.json was not found recently.");
    }

    const cacheBust = `t=${Date.now()}`;
    const candidates = assetCandidates("duplicates_report.json", cacheBust);

    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        sessionStorage.removeItem(DUPLICATES_MISSING_KEY);
        return response.json();
      } catch (error) {
        lastError = error;
      }
    }

    sessionStorage.setItem(DUPLICATES_MISSING_KEY, String(Date.now()));
    throw lastError || new Error("duplicates_report.json could not be loaded.");
  }

  async function runPluginModeOperation(mode, extraArgs) {
    const mutation = `
      mutation SmartDashboardRunOperation(
        $pluginId: ID!
        $args: Map
      ) {
        runPluginOperation(
          plugin_id: $pluginId
          args: $args
        )
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: mutation,
        variables: {
          pluginId: PLUGIN_ID,
          args: {
            task: mode,
            mode,
            language: pluginLanguage(),
            ...(extraArgs || {}),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    return payload.data ? payload.data.runPluginOperation : null;
  }

  async function queuePluginModeTask(mode, description, extraArgs) {
    const mutation = `
      mutation SmartDashboardRunTask(
        $pluginId: ID!
        $description: String!
        $argsMap: Map
      ) {
        runPluginTask(
          plugin_id: $pluginId
          description: $description
          args_map: $argsMap
        )
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: mutation,
        variables: {
          pluginId: PLUGIN_ID,
          description,
          argsMap: {
            task: mode,
            mode,
            language: pluginLanguage(),
            ...(extraArgs || {}),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    return payload.data && payload.data.runPluginTask;
  }

  async function runPluginModeTask(mode, description, extraArgs) {
    try {
      const jobId = await queuePluginModeTask(mode, description, extraArgs);
      return { queued: true, job_id: jobId };
    } catch (error) {
      console.warn("[Smart Dashboard] Could not queue plugin mode, running operation directly", error);
      const result = await runPluginModeOperation(mode, extraArgs);
      return { queued: false, result };
    }
  }

  async function triggerSetupOnce() {
    if (localStorage.getItem(SETUP_AUTOSTART_KEY) === "1") {
      return { started: false, reason: "already_started" };
    }

    localStorage.setItem(SETUP_AUTOSTART_KEY, "1");
    try {
      const result = await runPluginModeTask(SETUP_MODE, "Smart Dashboard automatic setup");
      return { started: true, ...result };
    } catch (error) {
      localStorage.removeItem(SETUP_AUTOSTART_KEY);
      console.warn("[Smart Dashboard] Could not auto-start setup", error);
      return { started: false, error: error.message || String(error) };
    }
  }

  async function triggerRecommendationsRefreshOnce() {
    if (sessionStorage.getItem(RECOMMENDATIONS_AUTOSTART_KEY) === "1") {
      return { started: false, reason: "already_started" };
    }

    sessionStorage.setItem(RECOMMENDATIONS_AUTOSTART_KEY, "1");
    try {
      const jobId = await queuePluginModeTask(RECOMMENDATIONS_MODE, "Smart Dashboard auto-refresh recommendations");
      return { started: true, queued: true, job_id: jobId };
    } catch (error) {
      // Do not fall back to synchronous auto-generation while another long plugin task may be running.
      console.warn("[Smart Dashboard] Could not auto-start recommendations", error);
      return { started: false, error: error.message || String(error) };
    }
  }

  function isUntitled(value) {
    return !value || String(value).trim().toLowerCase() === "untitled";
  }

  function estimateRecommendationSeconds(totalScenes) {
    const count = Number(totalScenes) || 0;
    return Math.max(5, Math.round(count / 80));
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value < 60) {
      return `${value}s`;
    }

    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  function fileNameFromPath(path) {
    if (!path) {
      return "";
    }

    const fileName = String(path).split(/[\\/]/).filter(Boolean).pop() || "";
    return fileName.replace(/\.[^.]+$/, "") || fileName;
  }

  function collectRecommendationScenes(data) {
    const rowKeys = ["library_spotlight", "forgotten_gems", "top_rated", "recently_watched", "smart_suggestions"];
    return rowKeys.flatMap((key) => (Array.isArray(data[key]) ? data[key] : []));
  }

  async function fetchSceneTitleIndex() {
    const query = `
      query SmartDashboardSceneTitles($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            files { path }
          }
        }
      }
    `;
    const scenes = [];
    const perPage = 1000;
    let page = 1;
    let total = null;

    while (total === null || scenes.length < total) {
      const response = await fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { filter: { page, per_page: perPage } },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
      }

      const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
      const pageScenes = Array.isArray(container.scenes) ? container.scenes : [];
      scenes.push(...pageScenes);
      total = Number.isFinite(Number(container.count)) ? Number(container.count) : scenes.length;
      if (!pageScenes.length || pageScenes.length < perPage) {
        break;
      }
      page += 1;
    }

    return new Map(
      scenes.map((scene) => {
        const firstFile = Array.isArray(scene.files) && scene.files.length ? scene.files[0] : null;
        return [
          String(scene.id),
          {
            title: scene.title,
            file_path: firstFile && firstFile.path,
            file_name: fileNameFromPath(firstFile && firstFile.path),
          },
        ];
      })
    );
  }

  function sceneFromGraphQL(scene, index) {
    const firstFile = Array.isArray(scene.files) && scene.files.length ? scene.files[0] : null;
    const filePath = firstFile && firstFile.path;
    const title = !isUntitled(scene.title) ? scene.title : fileNameFromPath(filePath) || `Scene ${scene.id}`;
    const width = firstFile && firstFile.width;
    const height = firstFile && firstFile.height;
    return {
      id: String(scene.id),
      title,
      stash_title: scene.title,
      file_path: filePath,
      file_name: fileNameFromPath(filePath),
      cover_path: scene.paths && scene.paths.screenshot,
      thumbnail: scene.paths && scene.paths.screenshot,
      rating: scene.rating100 ? Math.round((scene.rating100 / 20) * 100) / 100 : null,
      resolution: width && height ? `${width}x${height}` : "",
      score: Math.max(0, 1 - index / 1000),
      reason: t("reason.liveFromLibrary"),
      play_count: scene.play_count || 0,
      last_played_at: scene.last_played_at || null,
      tags: Array.isArray(scene.tags) ? scene.tags.map((tag) => tag.name).filter(Boolean) : [],
      performers: Array.isArray(scene.performers) ? scene.performers.map((performer) => performer.name).filter(Boolean) : [],
      studio: scene.studio && scene.studio.name,
      stash_url: `${window.location.origin}/scenes/${scene.id}`,
      stream_url: `${window.location.origin}/scene/${scene.id}/stream`,
    };
  }

  async function buildRecommendationsFromGraphQL() {
    const query = `
      query SmartDashboardLiveScenes($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            rating100
            play_count
            last_played_at
            paths { screenshot }
            files { path width height }
            tags { name }
            performers { name }
            studio { name }
          }
        }
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { filter: { page: 1, per_page: 100 } },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
    const scenes = container.scenes || [];
    const totalLibraryScenes = container.count || scenes.length;
    const items = scenes.map(sceneFromGraphQL);
    const topRated = items
      .filter((scene) => scene.rating !== null)
      .sort((left, right) => (right.rating || 0) - (left.rating || 0))
      .slice(0, 50);

    return {
      plugin: "Smart Dashboard & Advanced Duplicate Finder",
      generated_at: new Date().toISOString(),
      graphql_query_variant: "frontend_live_fallback",
      stash_base_url: window.location.origin,
      library_stats: {
        total_scenes: totalLibraryScenes,
        estimated_recommendation_seconds: estimateRecommendationSeconds(totalLibraryScenes),
      },
      preference_profile: { top_tags: [], top_studios: [] },
      library_spotlight: items.slice(0, 50),
      smart_suggestions: items.slice(0, 50),
      top_rated: topRated.length ? topRated : items.slice(0, 50),
      forgotten_gems: [],
      recently_watched: items.filter((scene) => scene.last_played_at).slice(0, 50),
    };
  }

  async function fetchLibraryStats() {
    const query = `
      query SmartDashboardLibraryStats($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
        }
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { filter: { page: 1, per_page: 1 } },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
    const totalScenes = Number(container.count || 0);
    return {
      total_scenes: totalScenes,
      estimated_recommendation_seconds: estimateRecommendationSeconds(totalScenes),
    };
  }

  async function fetchRandomLibraryScenes(count) {
    const query = `
      query SmartDashboardRandomScenes($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            rating100
            play_count
            last_played_at
            paths { screenshot }
            files { path width height }
            tags { name }
            performers { name }
            studio { name }
          }
        }
      }
    `;
    const firstResponse = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { filter: { page: 1, per_page: 1 } },
      }),
    });

    if (!firstResponse.ok) {
      throw new Error(`HTTP ${firstResponse.status}`);
    }

    const firstPayload = await firstResponse.json();
    if (firstPayload.errors && firstPayload.errors.length) {
      throw new Error(firstPayload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const firstContainer = firstPayload.data && firstPayload.data.findScenes ? firstPayload.data.findScenes : {};
    const totalScenes = Number(firstContainer.count || 0);
    const firstScene = Array.isArray(firstContainer.scenes) ? firstContainer.scenes[0] : null;
    if (totalScenes <= 0) {
      return [];
    }

    const wanted = Math.min(count, totalScenes);
    const indexes = new Set();
    while (indexes.size < wanted) {
      indexes.add(Math.floor(Math.random() * totalScenes));
    }

    const scenes = [];
    if (indexes.delete(0) && firstScene) {
      scenes.push(firstScene);
    }

    const requests = Array.from(indexes).map((index) =>
      fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { filter: { page: index + 1, per_page: 1 } },
        }),
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.json();
        })
        .then((payload) => {
          if (payload.errors && payload.errors.length) {
            throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
          }
          const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
          return Array.isArray(container.scenes) ? container.scenes[0] : null;
        })
    );

    const fetchedScenes = await Promise.all(requests);
    return scenes.concat(fetchedScenes.filter(Boolean)).map(sceneFromGraphQL);
  }

  async function fetchSearchLibraryScenes() {
    if (librarySearchCache) {
      return librarySearchCache;
    }

    const query = `
      query SmartDashboardSearchScenes($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            rating100
            play_count
            last_played_at
            paths { screenshot }
            files { path width height }
            tags { name }
            performers { name }
            studio { name }
          }
        }
      }
    `;
    const scenes = [];
    const perPage = 500;
    let page = 1;
    let total = null;

    while (total === null || scenes.length < total) {
      const response = await fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { filter: { page, per_page: perPage } },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
      }

      const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
      const pageScenes = Array.isArray(container.scenes) ? container.scenes : [];
      scenes.push(...pageScenes);
      total = Number.isFinite(Number(container.count)) ? Number(container.count) : scenes.length;
      if (!pageScenes.length || pageScenes.length < perPage) {
        break;
      }
      page += 1;
    }

    librarySearchCache = scenes.map((scene, index) => sceneFromGraphQL(scene, index));
    return librarySearchCache;
  }

  async function fetchDashboardData(options) {
    const data = await fetchRecommendations(options);
    try {
      const liveStats = await fetchLibraryStats();
      data.library_stats = {
        ...(data.library_stats || {}),
        ...liveStats,
      };
    } catch (error) {
      console.warn("[Smart Dashboard] Could not refresh live library stats", error);
    }
    return data;
  }

  async function enrichSceneTitles(data) {
    const scenes = collectRecommendationScenes(data);
    const needsEnrichment = scenes.some((scene) => isUntitled(scene.title) && !scene.file_name && !scene.file_path);
    if (!needsEnrichment) {
      return data;
    }

    try {
      const titleIndex = await fetchSceneTitleIndex();
      scenes.forEach((scene) => {
        const extra = titleIndex.get(String(scene.id));
        if (!extra) {
          return;
        }

        scene.stash_title = scene.stash_title || extra.title;
        scene.file_path = scene.file_path || extra.file_path;
        scene.file_name = scene.file_name || extra.file_name;
        if (isUntitled(scene.title)) {
          scene.title = !isUntitled(extra.title) ? extra.title : extra.file_name || scene.title;
        }
      });
    } catch (error) {
      console.warn("[Smart Dashboard] Could not enrich scene titles", error);
    }

    return data;
  }

  async function runCleanupTask(maxDurationSeconds) {
    const mutation = `
      mutation SmartDashboardCleanupShort(
        $pluginId: ID!
        $args: Map
      ) {
        runPluginOperation(
          plugin_id: $pluginId
          args: $args
        )
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          pluginId: PLUGIN_ID,
          args: {
            task: "cleanup_short",
            mode: "cleanup_short",
            max_duration_seconds: maxDurationSeconds,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    return payload.data ? payload.data.runPluginOperation : null;
  }

  function normalizeScene(scene, stashBaseUrl) {
    const id = scene.id || scene.scene_id || "";
    const tags = Array.isArray(scene.tags) ? scene.tags : [];
    const performers = Array.isArray(scene.performers) ? scene.performers : [];
    const fallbackTitle = fileNameFromPath(scene.file_name || scene.file_path);
    const title = isUntitled(scene.title) ? fallbackTitle || `Scene ${id}` : scene.title;
    return {
      id,
      title,
      cover: scene.cover_path || scene.thumbnail || scene.image || scene.screenshot || "",
      rating: scene.rating ?? null,
      reason: translateDisplayText(scene.reason || ""),
      resolution: scene.resolution || scene.quality || "",
      tags,
      performers,
      studio: scene.studio || "",
      playCount: scene.play_count || 0,
      lastPlayedAt: scene.last_played_at || "",
      stashUrl: scene.stash_url || `${stashBaseUrl.replace(/\/$/, "")}/scenes/${id}`,
      streamUrl: scene.stream_url || `${stashBaseUrl.replace(/\/$/, "")}/scene/${id}/stream`,
    };
  }

  function translateDisplayText(value) {
    if (!value) {
      return "";
    }
    if (global.SmartDashboardI18n && typeof global.SmartDashboardI18n.translateReason === "function") {
      return global.SmartDashboardI18n.translateReason(value);
    }
    return String(value);
  }

  function ratingText(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return t("card.unrated");
    }
    return `${Number(value).toFixed(1)} / 5`;
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  }

  function parseDurationInput(value) {
    const text = String(value || "").trim();
    if (!text) {
      return NaN;
    }

    if (!text.includes(":")) {
      return Number(text);
    }

    const parts = text.split(":").map((part) => Number(part));
    if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
      return NaN;
    }

    if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    }

    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function chooseFeatured(data) {
    const candidates = [
      ...(data.top_rated || []),
        ...(data.library_spotlight || []),
      ...(data.forgotten_gems || []),
      ...(data.smart_suggestions || []),
    ].filter(Boolean);

    if (!candidates.length) {
      return null;
    }

    const premiumPool = candidates.slice(0, Math.min(candidates.length, 12));
    return premiumPool[Math.floor(Math.random() * premiumPool.length)];
  }

  function registerPlugin() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.ReactDOM) {
      registerAttempts += 1;
      if (registerAttempts <= MAX_REGISTER_ATTEMPTS) {
        window.setTimeout(registerPlugin, 125);
      }
      return;
    }

    const React = api.React;
    const h = React.createElement;

    function Icon(props) {
      return h("span", { className: `sd-icon ${props.className || ""}`, "aria-hidden": "true" }, props.children);
    }

    function Pill(props) {
      return h("span", { className: "sd-pill" }, props.children);
    }

    function StatCard(props) {
      return h(
        "div",
        { className: "sd-stat-card" },
        h("div", { className: "sd-stat-icon" }, props.icon),
        h("div", { className: "sd-stat-value" }, props.value),
        h("div", { className: "sd-stat-label" }, props.label)
      );
    }

    function SceneCard(props) {
      const scene = normalizeScene(props.scene, props.stashBaseUrl);
      const meta = [ratingText(scene.rating), scene.resolution, scene.studio].filter(Boolean).join(" • ");

      return h(
        "a",
        {
          className: "sd-scene-card",
          href: scene.stashUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          onClick: props.onPlay
            ? (event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                  return;
                }

                event.preventDefault();
                props.onPlay(props.scene);
              }
            : undefined,
        },
        h("div", {
          className: "sd-scene-backdrop",
          style: scene.cover ? { backgroundImage: `url("${scene.cover}")` } : {},
        }),
        h("div", { className: "sd-card-gradient" }),
        h(
          "div",
          { className: "sd-card-content" },
          h("h3", { className: "sd-card-title", title: scene.title }, scene.title),
          h("div", { className: "sd-card-meta" }, meta || t("card.plays", { count: scene.playCount })),
          h("p", { className: "sd-card-reason" }, scene.reason || t("card.openInStash")),
          h(
            "div",
            { className: "sd-card-tags" },
            scene.tags.slice(0, 4).map((tag) => h(Pill, { key: tag }, tag))
          )
        )
      );
    }

    function Row(props) {
      const railRef = React.useRef(null);

      if (!props.scenes.length) {
        return null;
      }

      function scrollRail(direction) {
        const rail = railRef.current;
        if (!rail) {
          return;
        }

        const distance = Math.max(rail.clientWidth * 0.82, 320);
        const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
        const current = rail.scrollLeft;
        const target = current + direction * distance;
        const wrapThreshold = 8;

        if (maxScroll <= wrapThreshold) {
          return;
        }

        if (direction > 0 && (current >= maxScroll - wrapThreshold || target >= maxScroll)) {
          rail.scrollTo({
            left: 0,
            behavior: "smooth",
          });
          return;
        }

        if (direction < 0 && (current <= wrapThreshold || target <= 0)) {
          rail.scrollTo({
            left: maxScroll,
            behavior: "smooth",
          });
          return;
        }

        rail.scrollTo({
          left: target,
          behavior: "smooth",
        });
      }

      return h(
        "section",
        { className: "sd-row", id: props.id },
        h(
          "div",
          { className: "sd-row-header" },
          h(
            "div",
            null,
            h("h2", null, h(Icon, null, props.icon), props.title),
            h("p", null, props.subtitle)
          ),
          h("span", { className: "sd-row-count" }, t("row.scenesCount", { count: props.scenes.length }))
        ),
        h(
          "div",
          { className: "sd-rail-wrap" },
          h(
            "button",
            {
              className: "sd-rail-arrow sd-rail-arrow-left",
              type: "button",
              "aria-label": t("row.scrollLeft", { title: props.title }),
              onClick: () => scrollRail(-1),
            },
            "‹"
          ),
          h(
            "div",
            { className: "sd-rail", ref: railRef },
            props.scenes.map((scene, index) =>
              h(SceneCard, {
                key: `${props.id}-${scene.id || index}`,
                scene,
                stashBaseUrl: props.stashBaseUrl,
                onPlay: props.onPlay,
              })
            )
          ),
          h(
            "button",
            {
              className: "sd-rail-arrow sd-rail-arrow-right",
              type: "button",
              "aria-label": t("row.scrollRight", { title: props.title }),
              onClick: () => scrollRail(1),
            },
            "›"
          )
        )
      );
    }

    function uniqueScenesFromRows(rows) {
      const seen = new Set();
      const scenes = [];
      rows.forEach((row) => {
        const rowScenes = Array.isArray(row[3]) ? row[3] : [];
        rowScenes.forEach((scene) => {
          if (!scene) {
            return;
          }

          const key = String(scene.id || scene.stash_url || scene.file_path || scene.title || "");
          if (!key || seen.has(key)) {
            return;
          }

          seen.add(key);
          scenes.push(scene);
        });
      });
      return scenes;
    }

    function topTagNamesFromData(data, scenes) {
      const profileTags =
        data.preference_profile && Array.isArray(data.preference_profile.top_tags)
          ? data.preference_profile.top_tags
          : [];
      const names = profileTags
        .map((tag) => (typeof tag === "string" ? tag : tag && tag.name))
        .filter(Boolean);

      if (names.length) {
        return names.slice(0, 5);
      }

      const counts = new Map();
      scenes.forEach((scene) => {
        (Array.isArray(scene.tags) ? scene.tags : []).forEach((tag) => {
          const name = String(tag || "").trim();
          if (name) {
            counts.set(name, (counts.get(name) || 0) + 1);
          }
        });
      });

      return Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map((entry) => entry[0]);
    }

    function buildTopTagScenes(rows, data) {
      const scenes = uniqueScenesFromRows(rows);
      const tagNames = topTagNamesFromData(data, scenes);
      const normalizedTags = tagNames.map((tag) => tag.toLowerCase());

      if (!normalizedTags.length) {
        return { tagNames, scenes: [] };
      }

      const matches = scenes
        .map((scene) => {
          const sceneTags = (Array.isArray(scene.tags) ? scene.tags : []).map((tag) => String(tag).toLowerCase());
          const matchCount = normalizedTags.filter((tag) => sceneTags.includes(tag)).length;
          return { scene, matchCount };
        })
        .filter((item) => item.matchCount > 0)
        .sort((left, right) => right.matchCount - left.matchCount || (right.scene.score || 0) - (left.scene.score || 0))
        .map((item) => item.scene);

      return { tagNames, scenes: matches.slice(0, 50) };
    }

    function pickRandomScenes(scenes, count) {
      const pool = scenes.slice();
      for (let index = pool.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        const current = pool[index];
        pool[index] = pool[swapIndex];
        pool[swapIndex] = current;
      }
      return pool.slice(0, count);
    }

    function RandomPicks(props) {
      const [picks, setPicks] = React.useState(() => pickRandomScenes(props.scenes, 6));
      const [loading, setLoading] = React.useState(false);

      async function refreshPicks() {
        setLoading(true);
        try {
          const livePicks = await fetchRandomLibraryScenes(6);
          setPicks(livePicks.length ? livePicks : pickRandomScenes(props.scenes, 6));
        } catch (error) {
          console.warn("[Smart Dashboard] Could not fetch random library scenes", error);
          setPicks(pickRandomScenes(props.scenes, 6));
        } finally {
          setLoading(false);
        }
      }

      React.useEffect(() => {
        let active = true;
        setLoading(true);
        fetchRandomLibraryScenes(6)
          .then((livePicks) => {
            if (active) {
              setPicks(livePicks.length ? livePicks : pickRandomScenes(props.scenes, 6));
            }
          })
          .catch((error) => {
            console.warn("[Smart Dashboard] Could not fetch random library scenes", error);
            if (active) {
              setPicks(pickRandomScenes(props.scenes, 6));
            }
          })
          .finally(() => {
            if (active) {
              setLoading(false);
            }
          });

        return () => {
          active = false;
        };
      }, [props.scenes]);

      if (!props.scenes.length) {
        return null;
      }

      return h(
        "section",
        { className: "sd-row sd-random-picks", id: "random-picks" },
        h(
          "div",
          { className: "sd-row-header" },
          h(
            "div",
            { className: "sd-random-title-wrap" },
            h(
              "div",
              null,
              h("h2", null, h(Icon, null, "⟳"), t("random.title")),
              h("p", null, t("random.subtitle"))
            ),
            h(
              "button",
              {
                className: "sd-row-action-button",
                type: "button",
                disabled: loading,
                onClick: refreshPicks,
              },
              loading ? t("random.loading") : t("random.refresh")
            )
          )
        ),
        h(
          "div",
          { className: "sd-rail sd-random-rail" },
          picks.map((scene, index) =>
            h(SceneCard, {
              key: `random-${scene.id || scene.stash_url || index}`,
              scene,
              stashBaseUrl: props.stashBaseUrl,
              onPlay: props.onPlay,
            })
          )
        )
      );
    }

    function SearchPanel(props) {
      const [titleQuery, setTitleQuery] = React.useState("");
      const [tagQuery, setTagQuery] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const [results, setResults] = React.useState([]);
      const [totalMatches, setTotalMatches] = React.useState(0);
      const [message, setMessage] = React.useState(null);

      async function handleSearch(event) {
        event.preventDefault();
        const titleTerm = titleQuery.trim().toLowerCase();
        const tagTerms = tagQuery
          .split(",")
          .map((term) => term.trim().toLowerCase())
          .filter(Boolean);

        if (!titleTerm && !tagTerms.length) {
          setResults([]);
          setTotalMatches(0);
          setMessage({ type: "error", text: t("search.error.empty") });
          return;
        }

        setLoading(true);
        setMessage({ type: "info", text: t("search.info.searching") });
        try {
          const scenes = await fetchSearchLibraryScenes();
          const matches = scenes.filter((scene) => {
            const titleHaystack = [
              scene.title,
              scene.stash_title,
              scene.file_name,
              scene.file_path,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            const tagHaystack = (Array.isArray(scene.tags) ? scene.tags : [])
              .join(" ")
              .toLowerCase();
            const titleMatches = titleTerm ? titleHaystack.includes(titleTerm) : true;
            const tagMatches = tagTerms.length
              ? tagTerms.every((term) => tagHaystack.includes(term))
              : true;
            return titleMatches && tagMatches;
          });

          setResults(matches.slice(0, 50));
          setTotalMatches(matches.length);
          setMessage({
            type: matches.length ? "success" : "info",
            text: matches.length
              ? `${matches.length} match${matches.length === 1 ? "" : "es"} found. Showing up to 50.`
              : t("search.noResults"),
          });
        } catch (error) {
          console.warn("[Smart Dashboard] Library search failed", error);
          setResults([]);
          setTotalMatches(0);
          setMessage({ type: "error", text: t("tasks.failed") });
        } finally {
          setLoading(false);
        }
      }

      return h(
        "section",
        { className: "sd-search-panel", id: "cinematic-search" },
        h(
          "div",
          { className: "sd-search-header" },
          h("span", { className: "sd-tools-kicker" }, t("search.kicker")),
          h("h2", null, t("search.title")),
          h("p", null, t("search.description"))
        ),
        h(
          "form",
          { className: "sd-search-form", onSubmit: handleSearch },
          h(
            "label",
            { className: "sd-search-label" },
            t("search.titleLabel"),
            h("input", {
              className: "sd-search-input",
              type: "search",
              value: titleQuery,
              placeholder: t("search.titlePlaceholder"),
              disabled: loading,
              onChange: (event) => setTitleQuery(event.target.value),
            })
          ),
          h(
            "label",
            { className: "sd-search-label" },
            t("search.tagsLabel"),
            h("input", {
              className: "sd-search-input",
              type: "search",
              value: tagQuery,
              placeholder: t("search.tagsPlaceholder"),
              disabled: loading,
              onChange: (event) => setTagQuery(event.target.value),
            })
          ),
          h(
            "button",
            { className: "sd-search-button", type: "submit", disabled: loading },
            loading ? t("search.searching") : t("search.button")
          )
        ),
        message
          ? h("div", { className: `sd-search-status sd-search-status-${message.type}` }, message.text)
          : null,
        results.length
          ? h(Row, {
              id: "search-results",
              title: t("search.results.title"),
              subtitle:
                totalMatches === 1
                  ? t("search.results.subtitle", { count: totalMatches })
                  : t("search.results.subtitle_plural", { count: totalMatches }),
              scenes: results,
              icon: "⌕",
              stashBaseUrl: props.stashBaseUrl,
              onPlay: props.onPlay,
            })
          : null
      );
    }

    function PlayerOverlay(props) {
      if (!props.scene) {
        return null;
      }

      const scene = normalizeScene(props.scene, props.stashBaseUrl);
      return h(
        "div",
        { className: "sd-player-backdrop", role: "dialog", "aria-modal": "true" },
        h(
          "div",
          { className: "sd-player-panel" },
          h(
            "div",
            { className: "sd-player-header" },
            h(
              "div",
              null,
              h("span", { className: "sd-tools-kicker" }, t("player.nowPlaying")),
              h("h2", null, scene.title)
            ),
            h(
              "button",
              {
                className: "sd-player-close",
                type: "button",
                onClick: props.onClose,
                "aria-label": t("player.close"),
              },
              "×"
            )
          ),
          h("video", {
            className: "sd-player-video",
            src: scene.streamUrl,
            poster: scene.cover || undefined,
            controls: true,
            autoPlay: true,
            playsInline: true,
          }),
          h(
            "div",
            { className: "sd-player-actions" },
            h("span", null, [ratingText(scene.rating), scene.resolution, scene.studio].filter(Boolean).join(" • ")),
            h("a", { href: scene.stashUrl, target: "_blank", rel: "noopener noreferrer" }, t("player.openInStash"))
          )
        )
      );
    }

    function Hero(props) {
      const scene = props.scene ? normalizeScene(props.scene, props.stashBaseUrl) : null;
      const tags = scene ? [ratingText(scene.rating), scene.resolution, scene.studio, ...scene.tags.slice(0, 4)].filter(Boolean) : [];

      return h(
        "section",
        { className: "sd-hero" },
        h("div", {
          className: "sd-hero-image",
          style: scene && scene.cover ? { backgroundImage: `url("${scene.cover}")` } : {},
        }),
        h("div", { className: "sd-hero-overlay" }),
        h(
          "div",
          { className: "sd-hero-content" },
          h("div", { className: "sd-kicker" }, t("hero.featured")),
          h("h1", null, scene ? scene.title : t("app.title")),
          h(
            "p",
            null,
            scene
              ? scene.reason || t("hero.defaultDescription")
              : t("hero.generateHint")
          ),
          h("div", { className: "sd-hero-tags" }, tags.map((tag) => h(Pill, { key: tag }, tag))),
          h(
            "div",
            { className: "sd-hero-actions" },
            scene
              ? h(
                  "button",
                  {
                    className: "sd-button sd-button-primary",
                    type: "button",
                    onClick: () => (props.onPlay ? props.onPlay(props.scene) : window.open(scene.stashUrl, "_blank", "noopener,noreferrer")),
                  },
                  t("hero.play")
                )
              : null,
            h("button", { className: "sd-button sd-button-secondary", type: "button", onClick: () => window.location.reload() }, t("hero.refresh"))
          )
        )
      );
    }

    function PluginTasks(props) {
      const [statuses, setStatuses] = React.useState({});

      React.useEffect(() => {
        let active = true;
        triggerSetupOnce().then((result) => {
          if (!active) {
            return;
          }

          if (result.started) {
            setStatuses((current) => ({
              ...current,
              setup: result.queued
                ? t("tasks.setup.autoStarted", { jobId: result.job_id })
                : t("tasks.setup.autoDone"),
            }));
          } else if (result.error) {
            setStatuses((current) => ({
              ...current,
              setup: t("tasks.setup.autoFailed"),
            }));
          } else {
            setStatuses((current) => ({
              ...current,
              setup: t("tasks.setup.already"),
            }));
          }
        });

        return () => {
          active = false;
        };
      }, []);

      async function startTask(key, mode, description) {
        setStatuses((current) => ({ ...current, [key]: t("tasks.starting") }));
        try {
          const result = await runPluginModeTask(mode, description);
          const message = result.queued
            ? t("tasks.started", { jobId: result.job_id })
            : t("tasks.done");
          setStatuses((current) => ({ ...current, [key]: message }));
        } catch (error) {
          console.warn("[Smart Dashboard] Task start failed", error);
          setStatuses((current) => ({
            ...current,
            [key]: t("tasks.failed"),
          }));
        }
      }

      return h(
        "section",
        { className: "sd-task-panel", id: "plugin-tasks" },
        h(
          "div",
          { className: "sd-task-panel-header" },
          h("span", { className: "sd-tools-kicker" }, t("tasks.kicker")),
          h("h2", null, t("tasks.title")),
          h("p", null, t("tasks.description"))
        ),
        h(
          "div",
          { className: "sd-task-grid" },
          h(TaskButton, {
            title: t("tasks.setup.title"),
            description: t("tasks.setup.description"),
            button: t("tasks.setup.button"),
            status: statuses.setup,
            onClick: () => startTask("setup", SETUP_MODE, "Smart Dashboard manual setup"),
          }),
          h(TaskButton, {
            title: t("tasks.recommendations.title"),
            description: t("tasks.recommendations.description"),
            button: t("tasks.recommendations.button"),
            status: statuses.recommendations || (props.autostarted ? t("tasks.recommendations.autostart") : null),
            onClick: () =>
              startTask("recommendations", RECOMMENDATIONS_MODE, "Smart Dashboard refresh recommendations"),
          }),
          h(TaskButton, {
            title: t("tasks.duplicates.title"),
            description: t("tasks.duplicates.description"),
            button: t("tasks.duplicates.button"),
            status: statuses.duplicates,
            onClick: () => startTask("duplicates", DUP_SCAN_MODE, "Smart Dashboard duplicate scan"),
          })
        )
      );
    }

    function TaskButton(props) {
      return h(
        "div",
        { className: "sd-task-card" },
        h("h3", null, props.title),
        h("p", null, props.description),
        h(
          "button",
          { className: "sd-task-button", type: "button", onClick: props.onClick },
          props.button
        ),
        props.status ? h("div", { className: "sd-task-status" }, props.status) : null
      );
    }

    function DuplicateResults() {
      const [state, setState] = React.useState({ loading: true, error: null, report: null });

      function loadReport() {
        setState((current) => ({ ...current, loading: true, error: null }));
        fetchDuplicateReport({ forceAssetFetch: true })
          .then((report) => setState({ loading: false, error: null, report }))
          .catch((error) => setState({ loading: false, error, report: null }));
      }

      React.useEffect(() => {
        let active = true;
        fetchDuplicateReport()
          .then((report) => {
            if (active) {
              setState({ loading: false, error: null, report });
            }
          })
          .catch((error) => {
            if (active) {
              setState({ loading: false, error, report: null });
            }
          });

        return () => {
          active = false;
        };
      }, []);

      const report = state.report || {};
      const duplicates = Array.isArray(report.duplicates) ? report.duplicates : [];
      const skipped = Array.isArray(report.skipped) ? report.skipped.length : Number(report.skipped || 0);

      return h(
        "section",
        { className: "sd-duplicates", id: "duplicate-results" },
        h(
          "div",
          { className: "sd-duplicates-header" },
          h("span", { className: "sd-tools-kicker" }, t("duplicates.kicker")),
          h("h2", null, t("duplicates.title")),
          h(
            "p",
            null,
            t("duplicates.description")
          ),
          h(
            "button",
            { className: "sd-task-button", type: "button", onClick: loadReport, disabled: state.loading },
            state.loading ? t("random.loading") : t("duplicates.reload")
          )
        ),
        state.loading
          ? h("div", { className: "sd-duplicates-empty" }, t("duplicates.loading"))
          : state.error
            ? h(
                "div",
                { className: "sd-duplicates-empty" },
                h("strong", null, t("duplicates.empty")),
                h("span", null, t("duplicates.emptyHint"))
              )
            : h(
                "div",
                { className: "sd-duplicates-body" },
                h(
                  "div",
                  { className: "sd-duplicates-meta" },
                  h("span", null, t("duplicates.candidates", { count: duplicates.length })),
                  h(
                    "span",
                    null,
                    t("duplicates.hashed", {
                      done: report.hashed_scenes || 0,
                      total: report.total_scenes || 0,
                    })
                  ),
                  h("span", null, t("duplicates.cache", { count: report.cache_hits || 0 })),
                  h("span", null, t("duplicates.skipped", { count: skipped })),
                  report.generated_at
                    ? h("span", null, t("duplicates.updated", { date: formatDate(report.generated_at) }))
                    : null
                ),
                duplicates.length
                  ? h(
                      "div",
                      { className: "sd-duplicates-list" },
                      duplicates.slice(0, 25).map((item, index) =>
                        h(DuplicateCandidate, {
                          key: `${item.scene_a && item.scene_a.id}-${item.scene_b && item.scene_b.id}-${index}`,
                          item,
                        })
                      )
                    )
                  : h("div", { className: "sd-duplicates-empty" }, t("duplicates.none"))
              )
      );
    }

    function DuplicateCandidate(props) {
      const item = props.item || {};
      const sceneA = item.scene_a || {};
      const sceneB = item.scene_b || {};
      const confidence = Math.round(Number(item.confidence || 0) * 100);

      return h(
        "article",
        { className: "sd-duplicate-card" },
        h(
          "div",
          { className: "sd-duplicate-score" },
          h("strong", null, `${confidence}%`),
          h("span", null, t("duplicates.distance", { value: item.average_hamming_distance || "?" }))
        ),
        h(DuplicateScene, { scene: sceneA, label: "A" }),
        h(DuplicateScene, { scene: sceneB, label: "B" }),
        h(
          "div",
          { className: "sd-duplicate-samples" },
          `${item.compared_samples || 0} samples compared`
        )
      );
    }

    function DuplicateScene(props) {
      const scene = props.scene || {};
      const id = scene.id ? String(scene.id) : "";
      const fallbackTitle = fileNameFromPath(scene.path);
      const title = isUntitled(scene.title) ? fallbackTitle || `Scene ${id || "?"}` : scene.title || fallbackTitle || `Scene ${id || "?"}`;

      return h(
        "div",
        { className: "sd-duplicate-scene" },
        h("span", { className: "sd-duplicate-label" }, props.label),
        id
          ? h("a", { href: `${window.location.origin}/scenes/${id}`, target: "_blank", rel: "noopener noreferrer" }, title)
          : h("strong", null, title),
        scene.path ? h("small", null, scene.path) : null
      );
    }

    function LibraryTools() {
      const [durationInput, setDurationInput] = React.useState("0:30");
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const numericSeconds = parseDurationInput(durationInput);
      const isValid = Number.isFinite(numericSeconds) && numericSeconds > 0;

      async function handlePurge() {
        if (!isValid) {
          setStatus({
            type: "error",
            message: t("cleanup.invalid"),
          });
          return;
        }

        const confirmed = window.confirm(
          t("cleanup.confirm", { seconds: numericSeconds, input: durationInput })
        );
        if (!confirmed) {
          return;
        }

        setBusy(true);
        setStatus({ type: "info", message: t("cleanup.running") });
        try {
          await runCleanupTask(numericSeconds);
          setStatus({
            type: "success",
            message: t("cleanup.done"),
          });
        } catch (error) {
          console.warn("[Smart Dashboard] Cleanup start failed", error);
          setStatus({
            type: "error",
            message: t("cleanup.failed"),
          });
        } finally {
          setBusy(false);
        }
      }

      return h(
        "section",
        { className: "sd-tools", id: "library-tools" },
        h(
          "div",
          { className: "sd-tools-copy" },
          h("span", { className: "sd-tools-kicker" }, t("cleanup.kicker")),
          h("h2", null, t("cleanup.title")),
          h("p", null, t("cleanup.description"))
        ),
        h(
          "div",
          { className: "sd-cleanup-card" },
          h(
            "label",
            { className: "sd-cleanup-label", htmlFor: "sd-cleanup-seconds" },
            t("cleanup.label"),
            h("span", null, t("cleanup.hint"))
          ),
          h(
            "div",
            { className: "sd-cleanup-controls" },
            h("input", {
              id: "sd-cleanup-seconds",
              className: isValid ? "sd-cleanup-input" : "sd-cleanup-input sd-cleanup-input-invalid",
              type: "text",
              inputMode: "numeric",
              placeholder: t("cleanup.placeholder"),
              value: durationInput,
              disabled: busy,
              onChange: (event) => setDurationInput(event.target.value),
            }),
            h(
              "button",
              {
                className: "sd-purge-button",
                type: "button",
                disabled: busy || !isValid,
                onClick: handlePurge,
              },
              busy ? t("cleanup.purging") : t("cleanup.purge")
            )
          ),
          h(
            "p",
            { className: "sd-cleanup-warning" },
            t("cleanup.warning")
          ),
          status
            ? h(
                "div",
                { className: `sd-tool-status sd-tool-status-${status.type}` },
                status.message
              )
            : null
        )
      );
    }

    function renderLogo() {
      return h("div", { className: "sd-logo" }, h("span", null, t("app.brand")), " ", t("nav.cinematic"));
    }

    function formatTopbarMeta(data, libraryTotal, estimatedSeconds, autostartExtra) {
      const params = {
        version: UI_VERSION,
        count: libraryTotal,
        duration: formatDuration(estimatedSeconds),
        extra: autostartExtra || "",
      };
      if (data.generated_at) {
        return t("topbar.uiMeta", { ...params, date: formatDate(data.generated_at) });
      }
      return t("topbar.uiMetaNoDate", params);
    }

    function McpAgentPage() {
      const [indexStats, setIndexStats] = React.useState(null);
      const [messages, setMessages] = React.useState([]);
      const [input, setInput] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [scanBusy, setScanBusy] = React.useState(false);
      const [setupBusy, setSetupBusy] = React.useState(false);
      const [resultScenes, setResultScenes] = React.useState([]);
      const [playerScene, setPlayerScene] = React.useState(null);
      const [copyStatus, setCopyStatus] = React.useState("");
      const [, setLocaleTick] = React.useState(0);
      const stashBaseUrl = window.location.origin;
      const mcpConfigText = buildMcpConfigSnippet();

      React.useEffect(() => {
        if (!global.SmartDashboardI18n) {
          return undefined;
        }
        return global.SmartDashboardI18n.onChange(() => setLocaleTick((value) => value + 1));
      }, []);

      async function refreshIndexStats() {
        try {
          const payload = await fetchAgentIndexStats();
          setIndexStats(payload && payload.index ? payload.index : payload);
        } catch (error) {
          console.warn("[Smart Dashboard] Could not load agent index stats", error);
        }
      }

      async function ensureMcpDependencies() {
        if (localStorage.getItem(MCP_SETUP_KEY) === "1") {
          return;
        }
        setSetupBusy(true);
        try {
          await runPluginModeTask(SETUP_AGENT_MODE, "Smart Dashboard MCP agent setup");
          localStorage.setItem(MCP_SETUP_KEY, "1");
        } catch (error) {
          console.warn("[Smart Dashboard] MCP dependency setup failed", error);
        } finally {
          setSetupBusy(false);
        }
      }

      React.useEffect(() => {
        setMessages([{ role: "assistant", text: t("mcpAgent.welcome") }]);
        ensureMcpDependencies().then(refreshIndexStats);
      }, []);

      async function rebuildIndex() {
        setScanBusy(true);
        try {
          const result = await runPluginModeTask(BUILD_AGENT_INDEX_MODE, "Smart Dashboard agent index rebuild");
          if (!result.queued) {
            await refreshIndexStats();
            setMessages((current) => [
              ...current,
              { role: "assistant", text: t("mcpAgent.scanDone") },
            ]);
          } else {
            setMessages((current) => [
              ...current,
              { role: "assistant", text: t("mcpAgent.scanStarted", { jobId: result.job_id }) },
            ]);
          }
        } catch (error) {
          console.warn("[Smart Dashboard] Agent index rebuild failed", error);
          setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.scanFailed") }]);
        } finally {
          setScanBusy(false);
        }
      }

      async function handleSend(event) {
        if (event) {
          event.preventDefault();
        }
        const text = input.trim();
        if (!text || busy) {
          return;
        }
        setInput("");
        setBusy(true);
        setMessages((current) => [...current, { role: "user", text }]);
        try {
          const response = await sendAgentChatMessage(text);
          const reply = (response && response.reply) || t("mcpAgent.noReply");
          const scenes = (response && response.scenes) || [];
          setMessages((current) => [...current, { role: "assistant", text: reply }]);
          setResultScenes(scenes.map((scene) => normalizeScene(scene, stashBaseUrl)));
        } catch (error) {
          console.warn("[Smart Dashboard] Agent chat failed", error);
          setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.chatFailed") }]);
        } finally {
          setBusy(false);
        }
      }

      const stats = indexStats || {};
      const indexReady = Boolean(stats.ready && stats.scene_count > 0);

      return h(
        "div",
        { className: "sd-shell sd-mcp-shell" },
        h(
          "div",
          { className: "sd-topbar" },
          h("div", { className: "sd-logo sd-logo-mcp" }, h("span", null, t("app.brand")), " ", t("mcpAgent.title")),
          h(
            "div",
            { className: "sd-topbar-actions" },
            h(
              "button",
              { className: "sd-topbar-button", type: "button", onClick: () => window.smartDashboardOpen() },
              t("nav.cinematic")
            )
          )
        ),
        h(PlayerOverlay, { scene: playerScene, stashBaseUrl, onClose: () => setPlayerScene(null) }),
        h(
          "div",
          { className: "sd-mcp-layout" },
          h(
            "aside",
            { className: "sd-mcp-sidebar" },
            h("span", { className: "sd-tools-kicker" }, t("mcpAgent.sidebarKicker")),
            h("h2", null, t("mcpAgent.sidebarTitle")),
            h("p", null, t("mcpAgent.sidebarDescription")),
            h(
              "div",
              { className: "sd-mcp-stats" },
              h("div", null, t("mcpAgent.statScenes", { count: stats.scene_count || 0 })),
              h("div", null, t("mcpAgent.statTags", { count: stats.tag_count || 0 })),
              h("div", null, t("mcpAgent.statPerformers", { count: stats.performer_count || 0 })),
              h("div", null, t("mcpAgent.statStudios", { count: stats.studio_count || 0 }))
            ),
            h(
              "button",
              {
                className: "sd-task-button",
                type: "button",
                disabled: scanBusy || setupBusy,
                onClick: rebuildIndex,
              },
              scanBusy ? t("mcpAgent.scanning") : t("mcpAgent.scanButton")
            ),
            h(
              "button",
              {
                className: "sd-task-button sd-task-button-secondary",
                type: "button",
                disabled: setupBusy,
                onClick: ensureMcpDependencies,
              },
              setupBusy ? t("mcpAgent.setupBusy") : t("mcpAgent.setupButton")
            ),
            !indexReady
              ? h("p", { className: "sd-mcp-hint" }, t("mcpAgent.indexMissing"))
              : h("p", { className: "sd-mcp-hint" }, t("mcpAgent.indexReady")),
            h("div", { className: "sd-mcp-connect" },
              h("h3", null, t("mcpAgent.connectTitle")),
              h("p", null, t("mcpAgent.connectStep1")),
              h("p", null, t("mcpAgent.connectStep2")),
              h("p", null, t("mcpAgent.connectStep3")),
              h("p", null, t("mcpAgent.connectStep4")),
              h("p", { className: "sd-mcp-hint-muted" }, t("mcpAgent.connectDoc")),
              h(
                "button",
                {
                  className: "sd-task-button sd-task-button-secondary",
                  type: "button",
                  onClick: async () => {
                    const ok = await copyMcpConfigSnippet();
                    setCopyStatus(ok ? t("mcpAgent.copyConfigDone") : t("mcpAgent.copyConfigFailed"));
                  },
                },
                t("mcpAgent.copyConfig")
              ),
              copyStatus ? h("p", { className: "sd-mcp-copy-status" }, copyStatus) : null,
              h("pre", { className: "sd-mcp-config-pre" }, mcpConfigText)
            ),
            h("p", { className: "sd-mcp-hint sd-mcp-hint-muted" }, t("mcpAgent.externalHint"))
          ),
          h(
            "section",
            { className: "sd-mcp-chat" },
            h(
              "div",
              { className: "sd-mcp-messages" },
              messages.map((entry, index) =>
                h(
                  "div",
                  {
                    key: `${entry.role}-${index}`,
                    className: `sd-mcp-message sd-mcp-message-${entry.role}`,
                  },
                  entry.text
                )
              ),
              busy ? h("div", { className: "sd-mcp-message sd-mcp-message-assistant" }, t("mcpAgent.thinking")) : null
            ),
            h(
              "form",
              { className: "sd-mcp-input-row", onSubmit: handleSend },
              h("input", {
                className: "sd-mcp-input",
                type: "text",
                value: input,
                disabled: busy || !indexReady,
                placeholder: indexReady ? t("mcpAgent.inputPlaceholder") : t("mcpAgent.inputDisabled"),
                onChange: (event) => setInput(event.target.value),
              }),
              h(
                "button",
                { className: "sd-mcp-send", type: "submit", disabled: busy || !indexReady || !input.trim() },
                t("mcpAgent.send")
              )
            ),
            resultScenes.length
              ? h(
                  "div",
                  { className: "sd-mcp-results" },
                  h("h3", null, t("mcpAgent.resultsTitle")),
                  h(
                    "div",
                    { className: "sd-rail sd-mcp-rail" },
                    resultScenes.map((scene) =>
                      h(SceneCard, {
                        key: scene.id,
                        scene,
                        stashBaseUrl,
                        onPlay: setPlayerScene,
                      })
                    )
                  )
                )
              : null
          )
        )
      );
    }

    function DashboardPage() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null });
      const [refreshState, setRefreshState] = React.useState({ busy: false, message: null, type: "info" });
      const [playerScene, setPlayerScene] = React.useState(null);
      const [, setLocaleTick] = React.useState(0);

      React.useEffect(() => {
        if (!global.SmartDashboardI18n) {
          return undefined;
        }
        return global.SmartDashboardI18n.onChange(() => setLocaleTick((value) => value + 1));
      }, []);

      React.useEffect(() => {
        let active = true;
        fetchDashboardData()
          .then((data) => {
            if (active) {
              setState({ loading: false, error: null, data });
            }
          })
          .catch((error) => {
            if (active) {
              setState({ loading: false, error, data: null });
            }
          });

        return () => {
          active = false;
        };
      }, []);

      async function reloadDashboardData(options) {
        const data = await fetchDashboardData(options);
        setState({ loading: false, error: null, data });
        return data;
      }

      async function refreshRecommendations() {
        setRefreshState({ busy: true, message: t("refresh.rebuilding"), type: "info" });
        try {
          const result = await runPluginModeTask(RECOMMENDATIONS_MODE, "Smart Dashboard manual recommendations refresh", {
            refresh_reason: "manual_dashboard_refresh",
          });
          if (result.queued) {
            setRefreshState({
              busy: false,
              message: t("refresh.jobStarted", { jobId: result.job_id }),
              type: "info",
            });
          } else {
            sessionStorage.removeItem(RECOMMENDATIONS_MISSING_KEY);
            await reloadDashboardData({ forceAssetFetch: true });
            setRefreshState({
              busy: false,
              message: t("refresh.done"),
              type: "success",
            });
          }
        } catch (error) {
          console.warn("[Smart Dashboard] Recommendations refresh failed", error);
          setRefreshState({
            busy: false,
            message: t("refresh.failed"),
            type: "error",
          });
        }
      }

      if (state.loading) {
        return h(
          "div",
          { className: "sd-shell sd-centered" },
          h("div", { className: "sd-loader" }),
          h("p", null, t("loading.cinematic"))
        );
      }

      if (state.error) {
        return h(
          "div",
          { className: "sd-shell" },
          h(
            "div",
            { className: "sd-topbar" },
            renderLogo(),
            h(
              "div",
              { className: "sd-topbar-actions" },
              h("div", { className: "sd-updated" }, t("topbar.libraryTools")),
              h(
                "button",
                {
                  className: "sd-topbar-button",
                  type: "button",
                  onClick: refreshRecommendations,
                  disabled: refreshState.busy,
                },
                refreshState.busy ? t("topbar.refreshBusy") : t("topbar.refresh")
              )
            )
          ),
          h(
            "div",
            { className: "sd-centered sd-error-panel" },
            h("div", { className: "sd-empty-icon" }, "!"),
            h("h1", null, t("error.recommendationsNotFound")),
            h("p", null, t("error.recommendationsHint")),
            h("pre", null, t("error.reportUnavailable"))
          ),
          h(PluginTasks, { autostarted: false }),
          refreshState.message
            ? h("div", { className: `sd-refresh-status sd-refresh-status-${refreshState.type}` }, refreshState.message)
            : null,
          h(DuplicateResults, null),
          h(LibraryTools, null)
        );
      }

      const data = state.data || {};
      const stashBaseUrl = data.stash_base_url || window.location.origin;
      const featured = chooseFeatured(data);
      const rows = [
        [
          "library-spotlight",
          t("row.library_spotlight.title"),
          t("row.library_spotlight.subtitle"),
          data.library_spotlight || [],
          "▣",
        ],
        [
          "forgotten-gems",
          t("row.forgotten_gems.title"),
          t("row.forgotten_gems.subtitle"),
          data.forgotten_gems || [],
          "◆",
        ],
        ["top-rated", t("row.top_rated.title"), t("row.top_rated.subtitle"), data.top_rated || [], "★"],
        [
          "recently-watched",
          t("row.recently_watched.title"),
          t("row.recently_watched.subtitle"),
          data.recently_watched || [],
          "↺",
        ],
        [
          "smart-suggestions",
          t("row.smart_suggestions.title"),
          t("row.smart_suggestions.subtitle"),
          data.smart_suggestions || [],
          "✦",
        ],
      ];
      const totalScenes = rows.reduce((sum, row) => sum + row[3].length, 0);
      const totalUniqueScenes = new Set(
        rows.flatMap((row) => row[3].map((scene) => String(scene.id || ""))).filter(Boolean)
      ).size;
      const libraryTotal = data.library_stats && data.library_stats.total_scenes
        ? data.library_stats.total_scenes
        : totalUniqueScenes;
      const estimatedSeconds = data.library_stats && data.library_stats.estimated_recommendation_seconds
        ? data.library_stats.estimated_recommendation_seconds
        : estimateRecommendationSeconds(libraryTotal);
      const autostartLabel =
        data.recommendations_autostart && data.recommendations_autostart.started
          ? t("topbar.autostart", { duration: formatDuration(estimatedSeconds) })
          : "";
      const recommendationsAutostarted = Boolean(
        data.recommendations_autostart && data.recommendations_autostart.started
      );
      const randomPool = uniqueScenesFromRows(rows);
      const topTagFeed = buildTopTagScenes(rows, data);

      return h(
        "div",
        { className: "sd-shell" },
        h(
          "div",
          { className: "sd-topbar" },
          renderLogo(),
          h(
            "div",
            { className: "sd-topbar-actions" },
            h("div", { className: "sd-updated" }, formatTopbarMeta(data, libraryTotal, estimatedSeconds, autostartLabel)),
            h(
              "button",
              {
                className: "sd-topbar-button",
                type: "button",
                onClick: refreshRecommendations,
                disabled: refreshState.busy,
              },
              refreshState.busy ? t("topbar.refreshBusy") : t("topbar.refresh")
            )
          )
        ),
        refreshState.message
          ? h("div", { className: `sd-refresh-status sd-refresh-status-${refreshState.type}` }, refreshState.message)
          : null,
        h(PlayerOverlay, { scene: playerScene, stashBaseUrl, onClose: () => setPlayerScene(null) }),
        h(Hero, { scene: featured, stashBaseUrl, onPlay: setPlayerScene }),
        h(
          "section",
          { className: "sd-stats" },
          h(StatCard, { icon: "Σ", label: t("stats.videos"), value: libraryTotal }),
          h(StatCard, { icon: "≈", label: t("stats.estimated"), value: formatDuration(estimatedSeconds) }),
          h(StatCard, { icon: "▣", label: t("stats.spotlight"), value: (data.library_spotlight || []).length }),
          h(StatCard, { icon: "✦", label: t("stats.suggestions"), value: (data.smart_suggestions || []).length })
        ),
        h(SearchPanel, { stashBaseUrl, onPlay: setPlayerScene }),
        topTagFeed.scenes.length
          ? h(
              "div",
              { className: "sd-rows sd-top-tags-row" },
              h(Row, {
                id: "top-tags-feed",
                title: t("topTags.title"),
                subtitle: t("topTags.subtitle", { tags: topTagFeed.tagNames.join(", ") }),
                scenes: topTagFeed.scenes,
                icon: "#",
                stashBaseUrl,
                onPlay: setPlayerScene,
              })
            )
          : null,
        totalScenes
          ? h(
              "div",
              { className: "sd-rows" },
              rows.map((row) =>
                h(Row, {
                  key: row[0],
                  id: row[0],
                  title: row[1],
                  subtitle: row[2],
                  scenes: row[3],
                  icon: row[4],
                  stashBaseUrl,
                  onPlay: setPlayerScene,
                })
              )
            )
          : h(
              "div",
              { className: "sd-empty" },
              h("div", { className: "sd-empty-icon" }, "▶"),
              h("h2", null, t("empty.noRows")),
              h("p", null, t("empty.noRowsHint"))
            ),
        h(RandomPicks, { scenes: randomPool, stashBaseUrl, onPlay: setPlayerScene }),
        h(PluginTasks, { autostarted: recommendationsAutostarted }),
        h(DuplicateResults, null),
        h(LibraryTools, null)
      );
    }

    function closeDashboardOverlay() {
      const host = document.getElementById("smart-dashboard-overlay-root");
      if (!host) {
        return;
      }

      if (host._smartDashboardRoot && host._smartDashboardRoot.unmount) {
        host._smartDashboardRoot.unmount();
      } else if (api.ReactDOM.unmountComponentAtNode) {
        api.ReactDOM.unmountComponentAtNode(host);
      }
      host.remove();

      const params = new URLSearchParams(window.location.search);
      if (params.get("smart_dashboard") === "cinematic") {
        window.history.replaceState({}, "", `${pluginBasePath()}/`);
      }
    }

    function DashboardOverlay() {
      return h(
        "div",
        { className: "sd-overlay" },
        h(
          "button",
          {
            className: "sd-overlay-close",
            type: "button",
            onClick: closeDashboardOverlay,
            "aria-label": t("overlay.close"),
          },
          "×"
        ),
        h(DashboardPage, null)
      );
    }

    function showDashboardOverlay() {
      let host = document.getElementById("smart-dashboard-overlay-root");
      if (!host) {
        host = document.createElement("div");
        host.id = "smart-dashboard-overlay-root";
        document.body.appendChild(host);
      }

      window.history.pushState({}, "", `${pluginBasePath()}/?${DASHBOARD_QUERY}`);
      if (api.ReactDOM.createRoot) {
        if (!host._smartDashboardRoot) {
          host._smartDashboardRoot = api.ReactDOM.createRoot(host);
        }
        host._smartDashboardRoot.render(h(DashboardOverlay, null));
      } else {
        api.ReactDOM.render(h(DashboardOverlay, null), host);
      }
    }

    function closeMcpDashboardOverlay() {
      const host = document.getElementById("smart-dashboard-mcp-overlay-root");
      if (!host) {
        return;
      }
      if (host._smartDashboardMcpRoot && host._smartDashboardMcpRoot.unmount) {
        host._smartDashboardMcpRoot.unmount();
      } else if (api.ReactDOM.unmountComponentAtNode) {
        api.ReactDOM.unmountComponentAtNode(host);
      }
      host.remove();
      const params = new URLSearchParams(window.location.search);
      if (params.get("smart_dashboard") === "mcp") {
        window.history.replaceState({}, "", `${pluginBasePath()}/`);
      }
    }

    function McpDashboardOverlay() {
      return h(
        "div",
        { className: "sd-overlay sd-overlay-mcp" },
        h(
          "button",
          {
            className: "sd-overlay-close",
            type: "button",
            onClick: closeMcpDashboardOverlay,
            "aria-label": t("mcpAgent.close"),
          },
          "×"
        ),
        h(McpAgentPage, null)
      );
    }

    function showMcpDashboardOverlay() {
      let host = document.getElementById("smart-dashboard-mcp-overlay-root");
      if (!host) {
        host = document.createElement("div");
        host.id = "smart-dashboard-mcp-overlay-root";
        document.body.appendChild(host);
      }

      window.history.pushState({}, "", `${pluginBasePath()}/?${MCP_DASHBOARD_QUERY}`);
      if (api.ReactDOM.createRoot) {
        if (!host._smartDashboardMcpRoot) {
          host._smartDashboardMcpRoot = api.ReactDOM.createRoot(host);
        }
        host._smartDashboardMcpRoot.render(h(McpDashboardOverlay, null));
      } else {
        api.ReactDOM.render(h(McpDashboardOverlay, null), host);
      }
    }

    window.smartDashboardOpen = showDashboardOverlay;
    window.smartDashboardMcpOpen = showMcpDashboardOverlay;
  }

  function findNavigationContainer() {
    const selectors = [
      ".navbar-nav",
      ".navbar",
      "nav",
      "header",
      "[class*='Navbar']",
      "[class*='navbar']",
      "[class*='TopNav']",
      "[class*='top-nav']",
    ];
    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));

    return candidates.find((element) => {
      if (element.closest("#smart-dashboard-overlay-root") || element.closest(".sd-topbar")) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const hasUsefulSize = rect.width > 120 && rect.height > 20;
      const nearTop = rect.top < 140;
      const isVisible = window.getComputedStyle(element).display !== "none";
      return hasUsefulSize && nearTop && isVisible;
    });
  }

  function showMcpSetupToast(message, variant) {
    let toast = document.getElementById("smart-dashboard-mcp-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "smart-dashboard-mcp-toast";
      toast.className = "sd-mcp-toast";
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.dataset.variant = variant || "info";
    toast.hidden = false;
    window.clearTimeout(showMcpSetupToast._hideTimer);
    showMcpSetupToast._hideTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 12000);
  }

  async function triggerMcpAgentSetup(triggerButton) {
    if (triggerButton) {
      triggerButton.disabled = true;
      triggerButton.dataset.busy = "1";
    }

    showMcpSetupToast(t("mcp.installing"), "info");

    try {
      const result = await runPluginModeTask(SETUP_AGENT_MODE, "Smart Dashboard MCP agent setup");
      const message = result.queued
        ? t("mcp.started", { jobId: result.job_id })
        : t("mcp.done");
      showMcpSetupToast(message, "success");
    } catch (error) {
      console.warn("[Smart Dashboard] MCP agent setup failed", error);
      showMcpSetupToast(t("mcp.failed"), "error");
    } finally {
      if (triggerButton) {
        triggerButton.disabled = false;
        delete triggerButton.dataset.busy;
      }
    }
  }

  function appendNavigationButton(target, config) {
    if (document.getElementById(config.id)) {
      return;
    }

    const button = document.createElement("button");
    button.id = config.id;
    button.type = "button";
    button.className = config.className;
    button.textContent = config.label;
    button.addEventListener("click", config.onClick);

    if (target.tagName === "UL" || target.tagName === "OL") {
      const item = document.createElement("li");
      item.className = "sd-nav-item";
      item.appendChild(button);
      target.appendChild(item);
    } else {
      target.appendChild(button);
    }
  }

  function mountNavigationButton() {
    const target = findNavigationContainer();
    if (!target) {
      return false;
    }

    appendNavigationButton(target, {
      id: "smart-dashboard-nav-button",
      className: "sd-nav-button",
      label: t("nav.cinematic"),
      onClick: openRoute,
    });

    appendNavigationButton(target, {
      id: "smart-dashboard-mcp-nav-button",
      className: "sd-nav-button sd-nav-button-mcp",
      label: t("nav.mcp_server"),
      onClick: openMcpRoute,
    });

    return true;
  }

  function observeNavigationForButton() {
    if (window.smartDashboardNavObserver) {
      return;
    }

    let attempts = 0;
    window.smartDashboardNavObserver = new MutationObserver(() => {
      attempts += 1;
      if (mountNavigationButton() || attempts > 80) {
        window.smartDashboardNavObserver.disconnect();
        window.smartDashboardNavObserver = null;
      }
    });

    window.smartDashboardNavObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function syncNavigationLabels() {
    const cinematicButton = document.getElementById("smart-dashboard-nav-button");
    if (cinematicButton) {
      cinematicButton.textContent = t("nav.cinematic");
    }
    const mcpButton = document.getElementById("smart-dashboard-mcp-nav-button");
    if (mcpButton) {
      mcpButton.textContent = t("nav.mcp_server");
    }
  }

  function bootstrap() {
    const getGraphqlUrl = () => `${pluginBasePath()}/graphql`;
    const start = () => {
      registerPlugin();
      mountNavigationButton();
      syncNavigationLabels();
      if (global.SmartDashboardI18n) {
        global.SmartDashboardI18n.onChange(syncNavigationLabels);
      }
      observeNavigationForButton();
      handleDashboardDeepLink();
    };

    if (global.SmartDashboardI18n) {
      global.SmartDashboardI18n.init({ getGraphqlUrl }).then(start).catch(start);
      return;
    }
    start();
  }

  bootstrap();
})();
