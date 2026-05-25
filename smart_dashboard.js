(function () {
  "use strict";

  const PLUGIN_ID = "smart_dashboard";
  const UI_VERSION = "0.1.2";
  const DASHBOARD_QUERY = "smart_dashboard=cinematic";
  const ROUTE_LABEL = "Stash Cinematic";
  const SETUP_MODE = "setup";
  const RECOMMENDATIONS_MODE = "smart_dash_calc";
  const DUP_SCAN_MODE = "smart_dup_scan";
  const RECOMMENDATIONS_AUTOSTART_KEY = "smart_dashboard_recommendations_autostarted";
  const RECOMMENDATIONS_MISSING_KEY = "smart_dashboard_recommendations_missing_at";
  const RECOMMENDATIONS_MISSING_TTL_MS = 30000;
  const SETUP_AUTOSTART_KEY = "smart_dashboard_setup_autostarted";
  const MAX_REGISTER_ATTEMPTS = 80;
  let registerAttempts = 0;

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

  function openRoute() {
    if (typeof window.smartDashboardOpen === "function") {
      window.smartDashboardOpen();
      return;
    }

    window.history.pushState({}, "", `${pluginBasePath()}/?${DASHBOARD_QUERY}`);
  }

  function handleDashboardDeepLink() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("smart_dashboard") === "cinematic") {
      window.smartDashboardOpen();
    }
  }

  function shouldSkipMissingRecommendationsFetch() {
    const missingAt = Number(sessionStorage.getItem(RECOMMENDATIONS_MISSING_KEY) || 0);
    return missingAt > 0 && Date.now() - missingAt < RECOMMENDATIONS_MISSING_TTL_MS;
  }

  async function fetchRecommendations(options) {
    const forceAssetFetch = Boolean(options && options.forceAssetFetch);
    const cacheBust = `t=${Date.now()}`;
    const candidates = [
      `${assetUrl("recommendations.json")}?${cacheBust}`,
      `/plugin/${PLUGIN_ID}/assets/recommendations.json?${cacheBust}`,
    ];

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
    const autostart = await triggerRecommendationsRefreshOnce();
    const fallback = await buildRecommendationsFromGraphQL();
    fallback.recommendations_autostart = autostart;
    return fallback;
  }

  async function fetchDuplicateReport() {
    const cacheBust = `t=${Date.now()}`;
    const candidates = [
      `${assetUrl("duplicates_report.json")}?${cacheBust}`,
      `/plugin/${PLUGIN_ID}/assets/duplicates_report.json?${cacheBust}`,
    ];

    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("duplicates_report.json konnte nicht geladen werden.");
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
      reason: "Live aus deiner Stash-Bibliothek",
      play_count: scene.play_count || 0,
      last_played_at: scene.last_played_at || null,
      tags: Array.isArray(scene.tags) ? scene.tags.map((tag) => tag.name).filter(Boolean) : [],
      performers: Array.isArray(scene.performers) ? scene.performers.map((performer) => performer.name).filter(Boolean) : [],
      studio: scene.studio && scene.studio.name,
      stash_url: `${window.location.origin}/scenes/${scene.id}`,
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
      reason: scene.reason || "",
      resolution: scene.resolution || scene.quality || "",
      tags,
      performers,
      studio: scene.studio || "",
      playCount: scene.play_count || 0,
      lastPlayedAt: scene.last_played_at || "",
      stashUrl: scene.stash_url || `${stashBaseUrl.replace(/\/$/, "")}/scenes/${id}`,
    };
  }

  function ratingText(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "Unrated";
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
          h("div", { className: "sd-card-meta" }, meta || `${scene.playCount} plays`),
          h("p", { className: "sd-card-reason" }, scene.reason || "Open in Stash"),
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
        rail.scrollBy({
          left: direction * distance,
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
          h("span", { className: "sd-row-count" }, `${props.scenes.length} scenes`)
        ),
        h(
          "div",
          { className: "sd-rail-wrap" },
          h(
            "button",
            {
              className: "sd-rail-arrow sd-rail-arrow-left",
              type: "button",
              "aria-label": `${props.title} nach links scrollen`,
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
              })
            )
          ),
          h(
            "button",
            {
              className: "sd-rail-arrow sd-rail-arrow-right",
              type: "button",
              "aria-label": `${props.title} nach rechts scrollen`,
              onClick: () => scrollRail(1),
            },
            "›"
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
          h("div", { className: "sd-kicker" }, "Featured Scene"),
          h("h1", null, scene ? scene.title : ROUTE_LABEL),
          h(
            "p",
            null,
            scene
              ? scene.reason || "A standout recommendation selected from your local Stash library."
              : "Generate recommendations to unlock your cinematic dashboard."
          ),
          h("div", { className: "sd-hero-tags" }, tags.map((tag) => h(Pill, { key: tag }, tag))),
          h(
            "div",
            { className: "sd-hero-actions" },
            scene
              ? h(
                  "a",
                  { className: "sd-button sd-button-primary", href: scene.stashUrl, target: "_blank", rel: "noopener noreferrer" },
                  "Play"
                )
              : null,
            h("button", { className: "sd-button sd-button-secondary", type: "button", onClick: () => window.location.reload() }, "Refresh")
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
                ? `Automatisches Setup gestartet. Job ID: ${result.job_id}`
                : "Automatisches Setup direkt ausgefuehrt.",
            }));
          } else if (result.error) {
            setStatuses((current) => ({
              ...current,
              setup: `Setup konnte nicht automatisch gestartet werden: ${result.error}`,
            }));
          } else {
            setStatuses((current) => ({
              ...current,
              setup: "Setup wurde fuer diesen Browser bereits automatisch gestartet.",
            }));
          }
        });

        return () => {
          active = false;
        };
      }, []);

      async function startTask(key, mode, description) {
        setStatuses((current) => ({ ...current, [key]: "Starte Aufgabe..." }));
        try {
          const result = await runPluginModeTask(mode, description);
          const message = result.queued
            ? `Gestartet. Job ID: ${result.job_id}`
            : "Direkt ausgefuehrt. Report/Anzeige danach neu laden.";
          setStatuses((current) => ({ ...current, [key]: message }));
        } catch (error) {
          setStatuses((current) => ({
            ...current,
            [key]: `Konnte nicht gestartet werden: ${error.message || error}`,
          }));
        }
      }

      return h(
        "section",
        { className: "sd-task-panel", id: "plugin-tasks" },
        h(
          "div",
          { className: "sd-task-panel-header" },
          h("span", { className: "sd-tools-kicker" }, "Plugin Tasks"),
          h("h2", null, "Aufgaben direkt in Cinematic"),
          h(
            "p",
            null,
            "Setup wird beim ersten Oeffnen automatisch gestartet. Du kannst alle wichtigen Plugin-Aufgaben auch hier manuell starten."
          )
        ),
        h(
          "div",
          { className: "sd-task-grid" },
          h(TaskButton, {
            title: "Setup",
            description: "Installiert oder aktualisiert Python-Abhaengigkeiten.",
            button: "Setup starten",
            status: statuses.setup,
            onClick: () => startTask("setup", SETUP_MODE, "Smart Dashboard manual setup"),
          }),
          h(TaskButton, {
            title: "Recommendations",
            description: "Berechnet recommendations.json fuer Cinematic neu.",
            button: "Empfehlungen aktualisieren",
            status: statuses.recommendations || (props.autostarted ? "Automatisch gestartet." : null),
            onClick: () =>
              startTask("recommendations", RECOMMENDATIONS_MODE, "Smart Dashboard refresh recommendations"),
          }),
          h(TaskButton, {
            title: "Duplicate Scan",
            description: "Startet den visuellen pHash-Duplikatscan.",
            button: "Duplikatscan starten",
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
        fetchDuplicateReport()
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
          h("span", { className: "sd-tools-kicker" }, "Duplicate Results"),
          h("h2", null, "Duplikatscan Ergebnisse"),
          h(
            "p",
            null,
            "Hier werden die Kandidaten aus duplicates_report.json angezeigt, sobald der Duplikatscan gelaufen ist."
          ),
          h(
            "button",
            { className: "sd-task-button", type: "button", onClick: loadReport, disabled: state.loading },
            state.loading ? "Lade..." : "Report neu laden"
          )
        ),
        state.loading
          ? h("div", { className: "sd-duplicates-empty" }, "Duplikat-Report wird geladen...")
          : state.error
            ? h(
                "div",
                { className: "sd-duplicates-empty" },
                h("strong", null, "Noch kein Duplikat-Report gefunden."),
                h("span", null, "Starte den Duplikatscan oben im Cinematic Dashboard und lade danach den Report neu.")
              )
            : h(
                "div",
                { className: "sd-duplicates-body" },
                h(
                  "div",
                  { className: "sd-duplicates-meta" },
                  h("span", null, `Kandidaten: ${duplicates.length}`),
                  h("span", null, `Gehasht: ${report.hashed_scenes || 0}/${report.total_scenes || 0}`),
                  h("span", null, `Cache: ${report.cache_hits || 0}`),
                  h("span", null, `Übersprungen: ${skipped}`),
                  report.generated_at ? h("span", null, `Stand: ${formatDate(report.generated_at)}`) : null
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
                  : h("div", { className: "sd-duplicates-empty" }, "Keine Duplikat-Kandidaten im letzten Report.")
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
          h("span", null, `Distanz ${item.average_hamming_distance || "?"}`)
        ),
        h(DuplicateScene, { scene: sceneA, label: "A" }),
        h(DuplicateScene, { scene: sceneB, label: "B" }),
        h(
          "div",
          { className: "sd-duplicate-samples" },
          `${item.compared_samples || 0} Samples verglichen`
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
            message: "Bitte gib eine gueltige Dauer ein, z.B. 0:30, 1:15 oder 90.",
          });
          return;
        }

        const confirmed = window.confirm(
          `This removes all scenes shorter than ${numericSeconds} seconds (${durationInput}) from Stash only.\n\n` +
            `Die Videodateien im Ordner bleiben erhalten. Die Szenen erscheinen danach nicht mehr in Stash.\n\n` +
            "Continue / Fortfahren?"
        );
        if (!confirmed) {
          return;
        }

        setBusy(true);
        setStatus({ type: "info", message: "Cleanup wird ausgefuehrt..." });
        try {
          const result = await runCleanupTask(numericSeconds);
          const output = result && (result.output || result.result || result);
          setStatus({
            type: "success",
            message:
              typeof output === "string"
                ? output
                : "Cleanup abgeschlossen. Pruefe die Stash-Logs fuer Details.",
          });
        } catch (error) {
          setStatus({
            type: "error",
            message: `Cleanup konnte nicht gestartet werden: ${error.message || error}`,
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
          h("span", { className: "sd-tools-kicker" }, "Library Tools"),
          h("h2", null, "Short-Video Cleanup"),
          h(
            "p",
            null,
            "Remove scenes below a custom duration from Stash. The original video files stay on disk."
          )
        ),
        h(
          "div",
          { className: "sd-cleanup-card" },
          h(
            "label",
            { className: "sd-cleanup-label", htmlFor: "sd-cleanup-seconds" },
            "Delete videos shorter than (minutes:seconds):",
            h("span", null, "Videos kürzer als (Minuten:Sekunden) löschen:")
          ),
          h(
            "div",
            { className: "sd-cleanup-controls" },
            h("input", {
              id: "sd-cleanup-seconds",
              className: isValid ? "sd-cleanup-input" : "sd-cleanup-input sd-cleanup-input-invalid",
              type: "text",
              inputMode: "numeric",
              placeholder: "0:30 oder 90",
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
              busy ? "Starting..." : "Purge / Löschen"
            )
          ),
          h(
            "p",
            { className: "sd-cleanup-warning" },
            "Stash cleanup only: matching scene records are removed with sceneDestroy(delete_file: false). Examples: 0:30, 1:15, 90."
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

    function DashboardPage() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null });
      const [refreshState, setRefreshState] = React.useState({ busy: false, message: null, type: "info" });

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
        setRefreshState({ busy: true, message: "Recommendations werden neu berechnet...", type: "info" });
        try {
          const result = await runPluginModeTask(RECOMMENDATIONS_MODE, "Smart Dashboard manual recommendations refresh", {
            refresh_reason: "manual_dashboard_refresh",
          });
          if (result.queued) {
            setRefreshState({
              busy: false,
              message: `Recommendations wurden als Hintergrundjob gestartet. Job ID: ${result.job_id}. Nach Abschluss bitte erneut laden.`,
              type: "info",
            });
          } else {
            sessionStorage.removeItem(RECOMMENDATIONS_MISSING_KEY);
            await reloadDashboardData({ forceAssetFetch: true });
            setRefreshState({
              busy: false,
              message: "Recommendations wurden neu berechnet und neu geladen.",
              type: "success",
            });
          }
        } catch (error) {
          setRefreshState({
            busy: false,
            message: `Recommendations konnten nicht neu berechnet werden: ${error.message || error}`,
            type: "error",
          });
        }
      }

      if (state.loading) {
        return h(
          "div",
          { className: "sd-shell sd-centered" },
          h("div", { className: "sd-loader" }),
          h("p", null, "Loading Stash Cinematic...")
        );
      }

      if (state.error) {
        return h(
          "div",
          { className: "sd-shell" },
          h(
            "div",
            { className: "sd-topbar" },
            h("div", { className: "sd-logo" }, h("span", null, "Stash"), " Cinematic"),
            h(
              "div",
              { className: "sd-topbar-actions" },
              h("div", { className: "sd-updated" }, "Library tools available"),
              h(
                "button",
                {
                  className: "sd-topbar-button",
                  type: "button",
                  onClick: refreshRecommendations,
                  disabled: refreshState.busy,
                },
                refreshState.busy ? "Suche..." : "Recommendations neu suchen"
              )
            )
          ),
          h(
            "div",
            { className: "sd-centered sd-error-panel" },
            h("div", { className: "sd-empty-icon" }, "!"),
            h("h1", null, "recommendations.json not found"),
            h("p", null, "Klicke 'Recommendations neu suchen', um die Cinematic-Reihen neu aufzubauen. Library Tools sind weiterhin verfuegbar."),
            h("pre", null, String(state.error.message || state.error))
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
        ["library-spotlight", "Library Spotlight", "A reliable fallback row from your local scene library.", data.library_spotlight || [], "▣"],
        ["forgotten-gems", "Forgotten Gems", "Highly rated scenes waiting for a comeback.", data.forgotten_gems || [], "◆"],
        ["top-rated", "Top Rated", "The highest-rated scenes in your library.", data.top_rated || [], "★"],
        ["recently-watched", "Recently Watched", "Continue the mood from your latest sessions.", data.recently_watched || [], "↺"],
        ["smart-suggestions", "Smart Suggestions", "Generated from ratings, tags, studios, and watch history.", data.smart_suggestions || [], "✦"],
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
          ? ` • recommendations started (~${formatDuration(estimatedSeconds)})`
          : "";
      const recommendationsAutostarted = Boolean(
        data.recommendations_autostart && data.recommendations_autostart.started
      );

      return h(
        "div",
        { className: "sd-shell" },
        h(
          "div",
          { className: "sd-topbar" },
          h("div", { className: "sd-logo" }, h("span", null, "Stash"), " Cinematic"),
          h(
            "div",
            { className: "sd-topbar-actions" },
            h(
              "div",
              { className: "sd-updated" },
              data.generated_at
                ? `UI ${UI_VERSION} • Updated ${formatDate(data.generated_at)} • ${libraryTotal} videos • est. ${formatDuration(estimatedSeconds)}${autostartLabel}`
                : `UI ${UI_VERSION} • ${libraryTotal} videos • est. ${formatDuration(estimatedSeconds)}${autostartLabel}`
            ),
            h(
              "button",
              {
                className: "sd-topbar-button",
                type: "button",
                onClick: refreshRecommendations,
                disabled: refreshState.busy,
              },
              refreshState.busy ? "Suche..." : "Recommendations neu suchen"
            )
          )
        ),
        refreshState.message
          ? h("div", { className: `sd-refresh-status sd-refresh-status-${refreshState.type}` }, refreshState.message)
          : null,
        h(Hero, { scene: featured, stashBaseUrl }),
        h(
          "section",
          { className: "sd-stats" },
          h(StatCard, { icon: "Σ", label: "Videos in Stash", value: libraryTotal }),
          h(StatCard, { icon: "≈", label: "Estimated Build Time", value: formatDuration(estimatedSeconds) }),
          h(StatCard, { icon: "▣", label: "Library Spotlight", value: (data.library_spotlight || []).length }),
          h(StatCard, { icon: "✦", label: "Smart Suggestions", value: (data.smart_suggestions || []).length })
        ),
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
                })
              )
            )
          : h(
              "div",
              { className: "sd-empty" },
              h("div", { className: "sd-empty-icon" }, "▶"),
              h("h2", null, "No recommendation rows yet"),
              h("p", null, "Klicke oben auf 'Recommendations neu suchen', um die Reihen neu aufzubauen.")
            ),
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
            "aria-label": "Close Stash Cinematic",
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

    window.smartDashboardOpen = showDashboardOverlay;

    mountNavigationButton();
    observeNavigationForButton();
    handleDashboardDeepLink();
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

  function mountNavigationButton() {
    if (document.getElementById("smart-dashboard-nav-button")) {
      return true;
    }

    const target = findNavigationContainer();
    if (!target) {
      return false;
    }

    const button = document.createElement("button");
    button.id = "smart-dashboard-nav-button";
    button.type = "button";
    button.className = "sd-nav-button";
    button.textContent = "Cinematic";
    button.addEventListener("click", openRoute);

    if (target.tagName === "UL" || target.tagName === "OL") {
      const item = document.createElement("li");
      item.className = "sd-nav-item";
      item.appendChild(button);
      target.appendChild(item);
    } else {
      target.appendChild(button);
    }

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

  registerPlugin();
})();
