// ========== DNR 규칙: "변환 중" + "m3u8 XHR" 에만 Referer 강제 / Origin 제거 ==========
const RULE_ID_BASE = 9300;
const M3U8_ONLY_DNR = [
  {
    id: RULE_ID_BASE + 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "origin", operation: "remove" },
        { header: "referer", operation: "set", value: "https://twitter.com/" },
      ],
    },
    condition: {
      regexFilter: String.raw`pscp\.tv/Transcoding/.*\.m3u8(\?.*)?$`,
      resourceTypes: ["xmlhttprequest"],
    },
  },
  {
    id: RULE_ID_BASE + 2,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "origin", operation: "remove" },
        { header: "referer", operation: "set", value: "https://twitter.com/" },
      ],
    },
    condition: {
      regexFilter: String.raw`video\.pscp\.tv/Transcoding/.*\.m3u8(\?.*)?$`,
      resourceTypes: ["xmlhttprequest"],
    },
  },
];

const M3U8_PAT = /\.(m3u8)(\?|$)/i;
const SESSION_KEY = "tse_job";

// ===== 상태 저장 =====
async function getJob() {
  const s = await chrome.storage.local.get(SESSION_KEY);
  return s[SESSION_KEY] || { status: "idle" };
}
async function setJob(job) {
  await chrome.storage.local.set({ [SESSION_KEY]: job });
  if (job.status === "running") {
    const pct = Math.max(0, Math.min(99, parseInt(job.progress ?? 0, 10)));
    await chrome.action.setBadgeText({ text: String(pct) });
  } else if (job.status === "error") {
    await chrome.action.setBadgeText({ text: "!" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
  chrome.runtime.sendMessage({ type: "JOB_UPDATE", job }).catch(() => {});
}

// ===== DNR on/off =====
async function purgeAnyDnr() {
  try {
    const allIds = Array.from({ length: 2000 }, (_, i) => 8000 + i);
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [],
      removeRuleIds: allIds,
    });
  } catch (_) {}
}
async function enableDNRForConvert() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: M3U8_ONLY_DNR,
    removeRuleIds: M3U8_ONLY_DNR.map((r) => r.id),
  });
}
async function disableDNR() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [],
    removeRuleIds: M3U8_ONLY_DNR.map((r) => r.id),
  });
}

// ===== 오프스크린 보장 =====
async function ensureOffscreen() {
  if (chrome.offscreen?.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "ffmpeg.wasm 리먹스 처리",
  });
}

// ===== 설치/시작 =====
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ enabled: false, lastM3U8: null });
  await setJob({ status: "idle" });
  await chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
  await purgeAnyDnr();
});
chrome.runtime.onStartup?.addListener(async () => {
  await purgeAnyDnr();
});

// ===== 메시지 처리 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SET_ENABLED") {
    chrome.storage.local
      .set({ enabled: msg.enabled })
      .then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "JOB_GET") {
    getJob().then((job) => sendResponse(job));
    return true;
  }
  if (msg.type === "CONVERT_M4A") {
    (async () => {
      const job = {
        id: crypto.randomUUID(),
        url: msg.url,
        status: "running",
        progress: 0,
        logTail: [],
        startedAt: Date.now(),
      };
      await setJob(job);

      await enableDNRForConvert(); // 변환 동안만 헤더 강제
      await ensureOffscreen();
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_CONVERT",
        url: msg.url,
        jobId: job.id,
      });
      sendResponse(true);
    })();
    return true;
  }
  if (msg.type === "JOB_CANCEL") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_CANCEL" });
    disableDNR().catch(() => {});
    sendResponse(true);
    return;
  }
  return false;
});

// ===== 진행/완료/취소/저장(스트리밍) =====
const saveSessions = new Map(); // jobId -> { filename, mime, chunks:[], bytes:number }

chrome.runtime.onMessage.addListener(async (msg) => {
  // 진행률
  if (msg.type === "JOB_PROGRESS") {
    const job = await getJob();
    if (job.id !== msg.jobId) return;
    job.progress = msg.progress;
    if (msg.log) {
      job.logTail.push(msg.log);
      job.logTail = job.logTail.slice(-60);
    }
    await setJob(job);
  }

  // 취소
  if (msg.type === "JOB_CANCELED") {
    const job = await getJob();
    if (job.id !== msg.jobId) return;
    job.status = "canceled";
    job.endedAt = Date.now();
    await setJob(job);
    await disableDNR();
    // 세이브 세션 정리
    saveSessions.delete(msg.jobId);
    chrome.notifications?.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: "TSE",
      message: "변환이 취소되었습니다.",
    });
  }

  // === 저장 스트리밍 프로토콜 ===
  if (msg.type === "JOB_SAVE_START") {
    saveSessions.set(msg.jobId, {
      filename: msg.filename,
      mime: msg.mime || "audio/mp4",
      chunks: [],
      bytes: 0,
    });
    return;
  }
  if (msg.type === "JOB_SAVE_CHUNK") {
    const sess = saveSessions.get(msg.jobId);
    if (!sess) return;
    // ArrayBuffer를 바로 보관 (복사 없이 전달되도록 offscreen에서 transfer)
    sess.chunks.push(msg.chunk);
    sess.bytes += msg.chunk.byteLength;
    // 큰 파일에서도 안정: 메모리 사용량을 고려해 진행률 미세 업데이트 가능
    const job = await getJob();
    if (job.id === msg.jobId) {
      // 저장 단계 98% ~ 99% 사이에서 약간 움직이게
      job.progress = Math.min(
        99,
        Math.max(
          98,
          Math.round(
            (98 +
              Math.min(1, sess.bytes / (msg.totalBytes || sess.bytes)) * 1) *
              100
          ) / 100
        )
      );
      await setJob(job);
    }
    return;
  }
  if (msg.type === "JOB_SAVE_END") {
    const sess = saveSessions.get(msg.jobId);
    if (!sess) return;
    try {
      const blob = new Blob(sess.chunks, { type: sess.mime });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: sess.filename,
        saveAs: true,
      });
      // cleanup
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      saveSessions.delete(msg.jobId);

      chrome.runtime.sendMessage({
        type: "JOB_DONE",
        jobId: msg.jobId,
        ok: true,
        filename: sess.filename,
      });
    } catch (e) {
      saveSessions.delete(msg.jobId);
      chrome.runtime.sendMessage({
        type: "JOB_DONE",
        jobId: msg.jobId,
        ok: false,
        error: String(e?.message || e),
      });
    }
    await disableDNR();
    return;
  }

  // 완료(일반 경로)
  if (msg.type === "JOB_DONE") {
    const job = await getJob();
    if (job.id !== msg.jobId) return;
    job.status = msg.ok ? "finished" : "error";
    job.endedAt = Date.now();
    if (msg.ok) job.output = { filename: msg.filename };
    if (!msg.ok) job.error = msg.error;
    await setJob(job);
    await disableDNR();
    chrome.notifications?.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: "TSE",
      message: msg.ok ? "변환 완료!" : `변환 실패: ${msg.error || ""}`,
    });
  }
});

// ===== m3u8 자동 감지 =====
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const { enabled } = await chrome.storage.local.get({ enabled: false });
    if (!enabled) return;
    if (!M3U8_PAT.test(details.url)) return;

    await chrome.storage.local.set({ lastM3U8: details.url });
    chrome.runtime
      .sendMessage({ type: "URL_UPDATE", url: details.url })
      .catch(() => {});

    const job = await getJob();
    if (job.status === "idle") {
      job.url = details.url;
      await setJob(job);
    }

    chrome.notifications?.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: "TSE",
      message: "m3u8 링크 감지됨. [M4A 변환·다운로드]를 누르세요.",
    });
  },
  {
    urls: ["*://*.pscp.tv/*", "*://*.video.pscp.tv/*", "*://*.periscope.tv/*"],
    types: ["xmlhttprequest", "media"],
  }
);
