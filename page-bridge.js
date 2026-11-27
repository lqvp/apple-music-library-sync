(() => {
  if (window.AppleMusicLibraryTransfer?.version === 1) return;

  const API_ORIGIN = "https://amp-api.music.apple.com";
  const PAGE_SIZE = 100;
  const ADD_BATCH_SIZE = 50;
  const VERSION = 1;
  let cachedTokens = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const compact = (object) => {
    for (const key of Object.keys(object)) {
      if (object[key] === undefined || object[key] === null) delete object[key];
    }
    return object;
  };

  const chunk = (items, size) => {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  };

  const unique = (items) => [...new Set(items.filter(Boolean))];

  const getCookie = (name) => {
    const prefix = `${name}=`;
    return document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(prefix))
      ?.slice(prefix.length);
  };

  const decodeJwtPayload = (token) => {
    try {
      const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(base64));
    } catch (_) {
      return null;
    }
  };

  const scrapeDeveloperToken = async () => {
    const scripts = [...document.scripts]
      .map((script) => script.src)
      .filter((src) => src.includes("/assets/") && src.endsWith(".js"));

    for (const src of scripts) {
      try {
        const source = await fetch(src, { credentials: "include" }).then((response) => response.text());
        const tokens = source.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
        for (const token of tokens) {
          const payload = decodeJwtPayload(token);
          if (
            payload?.root_https_origin?.includes("apple.com") &&
            (!payload.exp || payload.exp * 1000 > Date.now())
          ) {
            return token;
          }
        }
      } catch (_) {
        // 次のbundleを試す
      }
    }
    return null;
  };

  const waitForTokens = async () => {
    if (cachedTokens) return cachedTokens;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      let musicKit = null;
      try {
        musicKit = window.MusicKit?.getInstance?.();
      } catch (_) {
        musicKit = null;
      }

      const mediaUserToken = musicKit?.musicUserToken || getCookie("media-user-token");
      let bearerToken = musicKit?.developerToken;
      if (!bearerToken && attempt >= 4) {
        bearerToken = await scrapeDeveloperToken();
      }

      if (bearerToken && mediaUserToken) {
        cachedTokens = { bearerToken, mediaUserToken };
        return cachedTokens;
      }
      await delay(300);
    }

    throw new Error("Apple Musicの認証情報を取得できませんでした。ログイン状態とページの再読み込みを確認してください。");
  };

  const showStatus = (message, state = "running") => {
    let element = document.getElementById("am-library-sync-status");
    if (!element) {
      element = document.createElement("div");
      element.id = "am-library-sync-status";
      element.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "max-width:420px",
        "padding:12px 14px",
        "border-radius:10px",
        "background:rgba(20,20,22,.96)",
        "color:white",
        "font:12px/1.45 -apple-system,BlinkMacSystemFont,sans-serif",
        "box-shadow:0 8px 30px rgba(0,0,0,.45)",
        "white-space:pre-wrap",
      ].join(";");
      document.body.appendChild(element);
    }
    element.style.border = state === "error" ? "1px solid #ff453a" : state === "done" ? "1px solid #30d158" : "1px solid #0a84ff";
    element.textContent = message;
  };

  const downloadJson = (filename, data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const apiFetch = async (path, options = {}, retry = 0) => {
    const tokens = await waitForTokens();
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${tokens.bearerToken}`,
      "Media-User-Token": tokens.mediaUserToken,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if ((response.status === 429 || response.status >= 500) && retry < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (retry + 1));
      return apiFetch(path, options, retry + 1);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300) || response.statusText}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const nextOffsetFrom = (next, currentOffset) => {
    if (!next) return null;
    try {
      const offset = Number(new URL(next, API_ORIGIN).searchParams.get("offset"));
      return Number.isFinite(offset) && offset > currentOffset ? offset : null;
    } catch (_) {
      return null;
    }
  };

  const fetchPaged = async (path, params, onPage, label) => {
    let offset = 0;
    let loaded = 0;
    let total = 0;

    for (let page = 1; page <= 1000; page += 1) {
      const json = await apiFetch(path, {
        params: {
          platform: "web",
          "format[resources]": "map",
          "art[url]": "f",
          l: "ja-jp",
          ...params,
          limit: PAGE_SIZE,
          offset,
        },
      });

      const rows = Array.isArray(json?.data) ? json.data : [];
      loaded += rows.length;
      total = Number(json?.meta?.total || total) || total;
      showStatus(`${label}: ${loaded}${total ? ` / ${total}` : ""}`);
      onPage(json, rows);

      if (!rows.length || rows.length < PAGE_SIZE || (total && loaded >= total)) break;
      offset = nextOffsetFrom(json?.next, offset) ?? offset + PAGE_SIZE;
      await delay(80);
    }

    return { loaded, total: total || loaded };
  };

  const resolvedRow = (row, json, libraryType) => {
    const map = json?.resources?.[libraryType] || {};
    return map[row.id] || row;
  };

  const catalogDetails = (fullRow, json, catalogType) => {
    const catalogRef = fullRow?.relationships?.catalog?.data?.[0];
    const playParams = fullRow?.attributes?.playParams;
    const catalogId = catalogRef?.id || playParams?.catalogId || playParams?.globalId;
    if (!catalogId) return {};
    const catalogResource =
      json?.resources?.[catalogType]?.[catalogId] ||
      (json?.included || []).find((resource) => resource.type === catalogType && resource.id === catalogId);
    return compact({
      catalogId,
      catalogUrl: catalogResource?.attributes?.url,
      catalogName: catalogResource?.attributes?.name,
    });
  };

  const exportLibraryMediaRow = (row, json, libraryType, catalogType) => {
    const fullRow = resolvedRow(row, json, libraryType);
    const attributes = fullRow.attributes || {};
    return compact({
      libraryId: fullRow.id,
      type: fullRow.type,
      ...catalogDetails(fullRow, json, catalogType),
      name: attributes.name,
      artistName: attributes.artistName,
      albumName: attributes.albumName,
      durationInMillis: attributes.durationInMillis,
      trackNumber: attributes.trackNumber,
      discNumber: attributes.discNumber,
      contentRating: attributes.contentRating,
      dateAdded: attributes.dateAdded,
    });
  };

  const exportPlaylistRow = (row, json) => {
    const fullRow = resolvedRow(row, json, "library-playlists");
    const attributes = fullRow.attributes || {};
    return compact({
      libraryId: fullRow.id,
      type: fullRow.type,
      ...catalogDetails(fullRow, json, "playlists"),
      name: attributes.name,
      description: attributes.description?.standard,
      canEdit: attributes.canEdit,
      isPublic: attributes.isPublic,
      hasCatalog: attributes.hasCatalog,
      dateAdded: attributes.dateAdded,
      trackTypes: attributes.trackTypes,
      tracks: [],
    });
  };

  const exportPlaylistTrack = (row, json, position) => {
    const fullRow = (json?.resources?.[row.type] || {})[row.id] || row;
    const attributes = fullRow.attributes || {};
    const isVideo = fullRow.type?.includes("music-video");
    const mediaType = isVideo ? "music-videos" : "songs";
    const catalog = fullRow.type?.startsWith("library-")
      ? catalogDetails(fullRow, json, mediaType)
      : compact({ catalogId: fullRow.id, catalogUrl: attributes.url, catalogName: attributes.name });

    return compact({
      position,
      libraryId: fullRow.type?.startsWith("library-") ? fullRow.id : undefined,
      type: mediaType,
      ...catalog,
      name: attributes.name,
      artistName: attributes.artistName,
      albumName: attributes.albumName,
      durationInMillis: attributes.durationInMillis,
    });
  };

  const mapLimit = async (items, limit, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await worker(items[index], index);
        }
      })
    );
    return results;
  };

  const shouldRecreatePlaylist = (playlist) =>
    Boolean(
      playlist.canEdit ||
      playlist.catalogId?.startsWith("pl.u-") ||
      !playlist.hasCatalog
    );

  const exportLibrary = async () => {
    await waitForTokens();
    showStatus("Apple MusicライブラリをExportしています…");

    const artists = [];
    await fetchPaged(
      "/v1/me/library/artists",
      { include: "catalog", meta: "sorts", sort: "name" },
      (json, rows) => {
        for (const row of rows) artists.push(exportLibraryMediaRow(row, json, "library-artists", "artists"));
      },
      "アーティスト"
    );

    const albums = [];
    await fetchPaged(
      "/v1/me/library/albums",
      { include: "catalog", meta: "sorts" },
      (json, rows) => {
        for (const row of rows) albums.push(exportLibraryMediaRow(row, json, "library-albums", "albums"));
      },
      "アルバム"
    );

    const songs = [];
    await fetchPaged(
      "/v1/me/library/songs",
      { include: "catalog", meta: "sorts" },
      (json, rows) => {
        for (const row of rows) songs.push(exportLibraryMediaRow(row, json, "library-songs", "songs"));
      },
      "曲"
    );

    const musicVideos = [];
    await fetchPaged(
      "/v1/me/library/music-videos",
      { include: "catalog", meta: "sorts" },
      (json, rows) => {
        for (const row of rows) musicVideos.push(exportLibraryMediaRow(row, json, "library-music-videos", "music-videos"));
      },
      "ミュージックビデオ"
    );

    const playlists = [];
    await fetchPaged(
      "/v1/me/library/playlists",
      { include: "catalog", meta: "sorts", sort: "name" },
      (json, rows) => {
        for (const row of rows) playlists.push(exportPlaylistRow(row, json));
      },
      "プレイリスト"
    );

    const trackExportPlaylists = playlists;
    let finishedPlaylists = 0;
    await mapLimit(trackExportPlaylists, 3, async (playlist) => {
      const tracks = [];
      try {
        await fetchPaged(
          `/v1/me/library/playlists/${encodeURIComponent(playlist.libraryId)}/tracks`,
          { include: "catalog" },
          (json, rows) => {
            for (const row of rows) tracks.push(exportPlaylistTrack(row, json, tracks.length));
          },
          `プレイリスト ${finishedPlaylists + 1}/${trackExportPlaylists.length}`
        );
      } catch (error) {
        playlist.trackExportError = error.message;
      }
      playlist.tracks = tracks;
      finishedPlaylists += 1;
    });

    const exportedAt = new Date().toISOString();
    const payload = {
      format: "apple-music-library-export",
      version: VERSION,
      exportedAt,
      storefront: location.pathname.split("/").filter(Boolean)[0] || "jp",
      counts: {
        artists: artists.length,
        albums: albums.length,
        songs: songs.length,
        musicVideos: musicVideos.length,
        playlists: playlists.length,
        playlistTracks: playlists.reduce((total, playlist) => total + playlist.tracks.length, 0),
      },
      artists,
      albums,
      songs,
      musicVideos,
      playlists,
    };

    const fileName = `apple-music-library-export-${exportedAt.replace(/[:.]/g, "-")}.json`;
    downloadJson(fileName, payload);
    showStatus(`Export完了\n${JSON.stringify(payload.counts, null, 2)}`, "done");
    return { ok: true, fileName, counts: payload.counts };
  };

  const addChunk = async (type, ids, report, reportKey) => {
    try {
      await apiFetch("/v1/me/library", {
        method: "POST",
        params: {
          [`ids[${type}]`]: ids.join(","),
          representation: "ids",
        },
      });
      report[reportKey].added += ids.length;
    } catch (error) {
      if (ids.length === 1) {
        report[reportKey].failed += 1;
        report.errors.push(`${type}:${ids[0]}: ${error.message}`);
        return;
      }
      const middle = Math.ceil(ids.length / 2);
      await addChunk(type, ids.slice(0, middle), report, reportKey);
      await addChunk(type, ids.slice(middle), report, reportKey);
    }
  };

  const addCatalogItems = async (type, ids, report, label, reportKey) => {
    const batches = chunk(unique(ids), ADD_BATCH_SIZE);
    for (let index = 0; index < batches.length; index += 1) {
      showStatus(`${label}をImportしています… ${index + 1}/${batches.length}`);
      await addChunk(type, batches[index], report, reportKey);
      await delay(150);
    }
  };

  const normalizeName = (name) => (name || "").trim().toLocaleLowerCase("ja");

  const firstCreatedResourceId = (response) => {
    if (Array.isArray(response?.data) && response.data[0]?.id) return response.data[0].id;
    const libraryPlaylists = response?.resources?.["library-playlists"];
    if (libraryPlaylists) return Object.keys(libraryPlaylists)[0];
    return null;
  };

  const addTracksToPlaylist = async (playlistId, trackRefs) => {
    const batches = chunk(trackRefs, 100);
    for (const batch of batches) {
      await apiFetch(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: "POST",
        params: { representation: "resources" },
        body: { data: batch },
      });
      await delay(150);
    }
  };

  const createPlaylist = async (playlist) => {
    const trackRefs = [];
    const seenTrackKeys = new Set();
    for (const track of playlist.tracks || []) {
      if (!track.catalogId) continue;
      const type = track.type === "music-videos" ? "music-videos" : "songs";
      const key = `${type}:${track.catalogId}`;
      if (seenTrackKeys.has(key)) continue;
      seenTrackKeys.add(key);
      trackRefs.push({ id: track.catalogId, type });
    }

    const attributes = {
      name: playlist.name || "Imported Playlist",
      description: playlist.description || "",
      isPublic: Boolean(playlist.isPublic),
    };
    const makeBody = (tracks) => ({
      attributes,
      relationships: { tracks: { data: tracks } },
    });
    const params = attributes.isPublic ? { with: "shared" } : {};

    try {
      const response = await apiFetch("/v1/me/library/playlists", {
        method: "POST",
        params,
        body: makeBody(trackRefs),
      });
      return { playlistId: firstCreatedResourceId(response), trackCount: trackRefs.length };
    } catch (error) {
      if (!trackRefs.length) throw error;

      // 曲数が多いプレイリストでは、空で作成してから分割追加する。
      const response = await apiFetch("/v1/me/library/playlists", {
        method: "POST",
        params,
        body: makeBody([]),
      });
      const playlistId = firstCreatedResourceId(response);
      if (!playlistId) throw error;
      await addTracksToPlaylist(playlistId, trackRefs);
      return { playlistId, trackCount: trackRefs.length };
    }
  };

  const existingPlaylistNames = async () => {
    const names = new Set();
    await fetchPaged(
      "/v1/me/library/playlists",
      { include: "catalog", meta: "sorts", sort: "name" },
      (json, rows) => {
        for (const row of rows) {
          const fullRow = resolvedRow(row, json, "library-playlists");
          names.add(normalizeName(fullRow.attributes?.name));
        }
      },
      "既存プレイリスト確認"
    );
    return names;
  };

  const importLibrary = async (payload) => {
    if (!payload || payload.format !== "apple-music-library-export") {
      throw new Error("apple-music-library-export形式のJSONではありません。");
    }

    await waitForTokens();
    const report = {
      format: "apple-music-library-import-report",
      version: VERSION,
      importedAt: null,
      songs: { input: 0, added: 0, failed: 0 },
      albums: { input: 0, added: 0, failed: 0 },
      musicVideos: { input: 0, added: 0, failed: 0 },
      catalogPlaylists: { input: 0, added: 0, failed: 0 },
      playlists: { input: 0, created: 0, skippedExisting: 0, failed: 0 },
      skippedNoCatalogId: {
        songs: 0,
        albums: 0,
        musicVideos: 0,
        playlistTracks: 0,
      },
      playlistResults: [],
      errors: [],
    };

    const songIds = unique((payload.songs || []).map((song) => song.catalogId));
    const albumIds = unique((payload.albums || []).map((album) => album.catalogId));
    const musicVideoIds = unique((payload.musicVideos || []).map((video) => video.catalogId));

    report.songs.input = songIds.length;
    report.albums.input = albumIds.length;
    report.musicVideos.input = musicVideoIds.length;
    report.skippedNoCatalogId.songs = (payload.songs || []).length - songIds.length;
    report.skippedNoCatalogId.albums = (payload.albums || []).length - albumIds.length;
    report.skippedNoCatalogId.musicVideos = (payload.musicVideos || []).length - musicVideoIds.length;

    await addCatalogItems("songs", songIds, report, "曲", "songs");
    await addCatalogItems("albums", albumIds, report, "アルバム", "albums");
    await addCatalogItems("music-videos", musicVideoIds, report, "ミュージックビデオ", "musicVideos");

    const playlists = payload.playlists || [];
    const catalogPlaylistIds = unique(
      playlists
        .filter((playlist) => playlist.hasCatalog && playlist.catalogId && !shouldRecreatePlaylist(playlist))
        .map((playlist) => playlist.catalogId)
    );
    report.catalogPlaylists.input = catalogPlaylistIds.length;
    await addCatalogItems("playlists", catalogPlaylistIds, report, "カタログプレイリスト", "catalogPlaylists");

    const existingNames = await existingPlaylistNames();
    const recreatablePlaylists = playlists.filter(shouldRecreatePlaylist);
    report.playlists.input = recreatablePlaylists.length;

    for (let index = 0; index < recreatablePlaylists.length; index += 1) {
      const playlist = recreatablePlaylists[index];
      const name = playlist.name || "(no name)";
      showStatus(`プレイリストをImportしています… ${index + 1}/${recreatablePlaylists.length}\n${name}`);

      if (existingNames.has(normalizeName(name))) {
        report.playlists.skippedExisting += 1;
        report.playlistResults.push({ name, status: "skipped-existing" });
        continue;
      }

      try {
        const result = await createPlaylist(playlist);
        report.playlists.created += 1;
        report.playlistResults.push({
          name,
          status: "created",
          playlistId: result.playlistId,
          trackCount: result.trackCount,
        });
        existingNames.add(normalizeName(name));
      } catch (error) {
        report.playlists.failed += 1;
        report.playlistResults.push({ name, status: "failed", error: error.message });
      }
      await delay(250);
    }

    report.skippedNoCatalogId.playlistTracks = playlists.reduce(
      (total, playlist) => total + (playlist.tracks || []).filter((track) => !track.catalogId).length,
      0
    );
    report.importedAt = new Date().toISOString();

    const fileName = `apple-music-library-import-report-${report.importedAt.replace(/[:.]/g, "-")}.json`;
    downloadJson(fileName, report);
    showStatus(`Import完了\n${JSON.stringify({
      songs: report.songs,
      albums: report.albums,
      musicVideos: report.musicVideos,
      playlists: report.playlists,
    }, null, 2)}`, report.errors.length ? "error" : "done");
    return { ok: true, fileName, report };
  };

  window.AppleMusicLibraryTransfer = {
    version: VERSION,
    async run(action, payload) {
      try {
        if (action === "export") return await exportLibrary();
        if (action === "import") return await importLibrary(payload);
        throw new Error(`Unknown action: ${action}`);
      } catch (error) {
        showStatus(`エラー: ${error.message}`, "error");
        return { ok: false, error: error.message };
      }
    },
  };
})();
