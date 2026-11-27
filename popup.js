const statusElement = document.getElementById("status");
const exportButton = document.getElementById("exportButton");
const importButton = document.getElementById("importButton");
const importFile = document.getElementById("importFile");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setStatus = (message) => {
  statusElement.textContent = message;
};

const setBusy = (busy) => {
  exportButton.disabled = busy;
  importButton.disabled = busy;
};

const isAppleMusicTab = (tab) => tab?.url?.startsWith("https://music.apple.com/");

const waitForTabComplete = async (tabId) => {
  for (let index = 0; index < 60; index += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await delay(250);
  }
  return chrome.tabs.get(tabId);
};

const findOrOpenAppleMusicTab = async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isAppleMusicTab(activeTab)) return activeTab;

  const existingTabs = await chrome.tabs.query({ url: "https://music.apple.com/*" });
  if (existingTabs.length) {
    const tab = existingTabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    return waitForTabComplete(tab.id);
  }

  setStatus("Apple Musicを開いています。ログイン済みであることを確認してください…");
  const tab = await chrome.tabs.create({
    url: "https://music.apple.com/jp/library",
    active: true,
  });
  return waitForTabComplete(tab.id);
};

const runBridge = async (action, payload) => {
  const tab = await findOrOpenAppleMusicTab();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["page-bridge.js"],
    world: "MAIN",
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (bridgeAction, bridgePayload) => {
      if (!window.AppleMusicLibraryTransfer) {
        return { ok: false, error: "page bridgeを初期化できませんでした" };
      }
      return window.AppleMusicLibraryTransfer.run(bridgeAction, bridgePayload);
    },
    args: [action, payload ?? null],
    world: "MAIN",
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error("Apple Musicタブから結果を取得できませんでした。");
  if (!result.ok) throw new Error(result.error || "不明なエラー");
  return result;
};

const formatCounts = (counts) => Object.entries(counts)
  .map(([key, value]) => `${key}: ${value}`)
  .join("\n");

exportButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Exportを開始しています…\n処理中はApple Musicタブ右下にも進行状況が表示されます。");
  try {
    const result = await runBridge("export");
    setStatus(`Export完了: ${result.fileName}\n\n${formatCounts(result.counts)}`);
  } catch (error) {
    setStatus(`Export失敗: ${error.message}`);
  } finally {
    setBusy(false);
  }
});

importButton.addEventListener("click", async () => {
  const file = importFile.files?.[0];
  if (!file) {
    setStatus("ImportするJSONファイルを選択してください。");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    setStatus(`JSONを読めませんでした: ${error.message}`);
    return;
  }

  const counts = payload.counts
    ? formatCounts(payload.counts)
    : "counts情報なし";
  const confirmed = confirm(
    `現在ログインしているApple Musicアカウントのライブラリに項目を追加します。\n\n${counts}\n\n実行しますか？`
  );
  if (!confirmed) return;

  setBusy(true);
  setStatus("Importを開始しています…\nライブラリを変更するため、完了までApple Musicタブを閉じないでください。");
  try {
    const result = await runBridge("import", payload);
    const report = result.report;
    setStatus(
      `Import完了: ${result.fileName}\n\n` +
      `songs: added ${report.songs.added}, failed ${report.songs.failed}\n` +
      `albums: added ${report.albums.added}, failed ${report.albums.failed}\n` +
      `musicVideos: added ${report.musicVideos.added}, failed ${report.musicVideos.failed}\n` +
      `playlists: created ${report.playlists.created}, skipped ${report.playlists.skippedExisting}, failed ${report.playlists.failed}\n` +
      (report.errors.length ? `\nerrors: ${report.errors.length}件（report JSONを確認）` : "")
    );
  } catch (error) {
    setStatus(`Import失敗: ${error.message}`);
  } finally {
    setBusy(false);
  }
});
