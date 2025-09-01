const toggle = document.getElementById("toggle");
const urlEl = document.getElementById("url");
const logEl = document.getElementById("log");
const btnConvert = document.getElementById("convert");
const btnCancel = document.getElementById("cancel");
const btnClear = document.getElementById("clear");
const bar = document.getElementById("bar");

function appendLog(s) {
  logEl.textContent = (logEl.textContent + "\n" + s).trim();
  logEl.scrollTop = logEl.scrollHeight;
}

function render(job) {
  document.title = `TSE · ${job.status || "idle"}`;

  const effectiveUrl = job.url || urlEl.textContent || "";
  if (effectiveUrl && effectiveUrl !== "-") urlEl.textContent = effectiveUrl;

  const lines = [];
  lines.push(`상태: ${job.status || "idle"}`);
  if (job.progress != null) lines.push(`진행률: ${Math.round(job.progress)}%`);
  if (job.output?.filename) lines.push(`파일: ${job.output.filename}`);
  if (job.error) lines.push(`에러: ${job.error}`);
  if (job.logTail?.length) {
    lines.push("");
    lines.push(...job.logTail);
  }
  logEl.textContent = lines.join("\n");

  const running = job.status === "running";
  const pct = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  bar.style.width = pct + "%";

  btnConvert.disabled = running || !(effectiveUrl && effectiveUrl !== "-");
  btnCancel.disabled = !running;
}

async function refresh() {
  const st = await chrome.storage.local.get({ enabled: false, lastM3U8: null });
  toggle.checked = st.enabled;
  urlEl.textContent = st.lastM3U8 || "-";
  const job = await chrome.runtime.sendMessage({ type: "JOB_GET" });
  render(job);
}
refresh();

toggle.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SET_ENABLED",
    enabled: toggle.checked,
  });
  refresh();
});

btnClear.addEventListener("click", async () => {
  await chrome.storage.local.set({ lastM3U8: null });
  await refresh();
});

btnConvert.addEventListener("click", async () => {
  const { lastM3U8 } = await chrome.storage.local.get("lastM3U8");
  const job = await chrome.runtime.sendMessage({ type: "JOB_GET" });
  const url = job.url || lastM3U8;
  if (!url) {
    appendLog(
      "m3u8이 아직 감지되지 않았습니다. 스페이스 재생 후 다시 시도하세요."
    );
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "CONVERT_M4A", url });
  if (!res || res.ok === false) {
    appendLog(res?.message || "다른 변환 작업이 이미 진행 중입니다.");
    return;
  }
  appendLog("변환 시작… (팝업 닫아도 계속 진행)");
});

btnCancel.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "JOB_CANCEL" });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "URL_UPDATE") urlEl.textContent = msg.url || "-";
  if (msg.type === "JOB_UPDATE") render(msg.job);
  if (msg.type === "LOG") appendLog(msg.text);
});
