const { createFFmpeg } = FFmpeg;

let ffmpeg;
let cancelFlag = false;
let aborter = null;
let currentJobId = null;
let currentPct = 0;
let lastTick = Date.now();
let ffmpegRunning = false;
let canceledSent = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "OFFSCREEN_CONVERT") {
    cancelFlag = false;
    canceledSent = false;
    convert(msg.jobId, msg.url).catch((err) => {
      if (!canceledSent) {
        done(msg.jobId, false, null, String(err?.message || err));
      }
    });
  }
  if (msg.type === "OFFSCREEN_CANCEL") {
    handleCancel().catch(() => {});
  }
});

function progress(jobId, p, log) {
  lastTick = Date.now();
  chrome.runtime
    .sendMessage({
      type: "JOB_PROGRESS",
      jobId,
      progress: Math.max(0, Math.min(100, p)),
      log,
    })
    .catch(() => {});
}
function done(jobId, ok, filename, error) {
  chrome.runtime
    .sendMessage({ type: "JOB_DONE", jobId, ok, filename, error })
    .catch(() => {});
}
function canceled(jobId) {
  canceledSent = true;
  chrome.runtime.sendMessage({ type: "JOB_CANCELED", jobId }).catch(() => {});
}

async function ensureFF() {
  if (ffmpeg) return;
  ffmpeg = createFFmpeg({
    corePath: chrome.runtime.getURL("lib/ffmpeg-core.js"),
    // workerPath: chrome.runtime.getURL("lib/ffmpeg-core.worker.js"), // 이 줄은 createFFmpeg 옵션에 직접 포함되지 않음
    wasmPath: chrome.runtime.getURL("lib/ffmpeg-core.wasm"),
    log: false,
    // 이 옵션을 추가하여 blob 사용을 비활성화합니다.
    mainName: "main",
  });
  await ffmpeg.load();

  ffmpeg.setLogger(({ message }) => {
    if (/Opening|frame=|size=|time=|bitrate=|speed=/.test(message)) {
      chrome.runtime
        .sendMessage({
          type: "JOB_PROGRESS",
          jobId: currentJobId,
          progress: currentPct,
          log: message.trim(),
        })
        .catch(() => {});
    }
  });
  ffmpeg.setProgress(({ ratio }) => {
    const p = 80 + Math.min(18, Math.round((ratio || 0) * 18 * 100) / 100);
    currentPct = p;
    progress(currentJobId, p, "리먹스 진행…");
  });

  setInterval(() => {
    if (!currentJobId) return;
    if (Date.now() - lastTick > 60000) {
      handleCancel("네트워크 타임아웃(60s 무진행)").catch(() => {});
    }
  }, 5000);
}

async function handleCancel(reason = "사용자 취소") {
  try {
    cancelFlag = true;
    try {
      aborter?.abort();
    } catch (e) {}
    if (ffmpegRunning && ffmpeg?.exit) {
      try {
        await ffmpeg.exit();
      } catch (e) {}
      ffmpeg = null;
    }
  } finally {
    if (currentJobId && !canceledSent) {
      canceled(currentJobId);
    }
    currentJobId = null;
  }
}

async function convert(jobId, masterUrl) {
  currentJobId = jobId;
  progress(jobId, 0, "m3u8 파싱…");

  const { segments, extinf } = await resolvePlaylist(masterUrl);
  if (segments.length === 0) throw new Error("세그먼트를 찾지 못했습니다.");

  await ensureFF();

  const segNames = [];
  const N = segments.length;

  for (let i = 0; i < N; i++) {
    if (cancelFlag) throw new Error("사용자 취소");
    aborter = new AbortController();
    const u = segments[i];
    const res = await fetch(u, {
      credentials: "include",
      signal: aborter.signal,
    });
    if (!res.ok) throw new Error(`세그먼트 실패: ${res.status} ${u}`);
    const ab = await res.arrayBuffer();
    const name = `seg_${String(i).padStart(5, "0")}${guessExt(u)}`;
    ffmpeg.FS("writeFile", name, new Uint8Array(ab));
    segNames.push(name);

    if (i % 10 === 0) {
      const pct = Math.min(80, Math.round((i / N) * 80));
      currentPct = pct;
      progress(jobId, pct, `다운로드 ${i}/${N}`);
    }
  }

  const local = buildLocalM3U8(segNames, extinf);
  ffmpeg.FS("writeFile", "local.m3u8", new TextEncoder().encode(local));

  if (cancelFlag) throw new Error("사용자 취소");

  progress(jobId, 85, "무손실 리먹스…");
  ffmpegRunning = true;
  try {
    await ffmpeg.run(
      "-protocol_whitelist",
      "file,crypto",
      "-i",
      "local.m3u8",
      "-vn",
      "-sn",
      "-map",
      "0:a",
      "-c:a",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-movflags",
      "+faststart",
      "out.m4a"
    );
    } finally {
      ffmpegRunning = false;
    }

    try {
      for (const name of segNames) {
        ffmpeg.FS("unlink", name);
      }
      ffmpeg.FS("unlink", "local.m3u8");
    } catch (e) {
      // cleanup failure is non-critical
    }

    if (cancelFlag) throw new Error("사용자 취소");

  // === 대용량 안전 저장: 조각 전송 ===
  const data = ffmpeg.FS("readFile", "out.m4a"); // Uint8Array
  const totalBytes = data.length;
  const CHUNK = 4 * 1024 * 1024; // 4MB

  chrome.runtime.sendMessage({
    type: "JOB_SAVE_START",
    jobId,
    filename: makeFilename(),
    mime: "audio/mp4",
  });

  for (let offset = 0; offset < totalBytes; offset += CHUNK) {
    if (cancelFlag) throw new Error("사용자 취소");
    const end = Math.min(totalBytes, offset + CHUNK);
    const chunk = data.slice(offset, end); // Uint8Array (backed by new buffer)
    // 전송 비용을 줄이기 위해 ArrayBuffer를 transferable로 보냄
    chrome.runtime
      .sendMessage(
        { type: "JOB_SAVE_CHUNK", jobId, totalBytes, chunk: chunk.buffer },
        { transfer: [chunk.buffer] }
      )
      .catch(() => {});
    // 저장 단계 진행률 (98%까지)
    const savePct = 98 * (end / totalBytes);
    progress(
      jobId,
      Math.max(90, Math.min(98, Math.round(savePct))),
      `저장 중 ${Math.ceil(end / CHUNK)}/${Math.ceil(totalBytes / CHUNK)}`
    );
    await microtask(); // 이벤트 루프 양보
  }

  chrome.runtime.sendMessage({ type: "JOB_SAVE_END", jobId }).catch((err) => {
    done(jobId, false, null, String(err?.message || err));
  });

  // 완료 이벤트는 background가 JOB_SAVE_END 처리 후 JOB_DONE으로 전송
}

function microtask() {
  return new Promise(requestAnimationFrame);
}

function makeFilename() {
  return `space_${new Date().toISOString().replace(/[:.]/g, "-")}.m4a`;
}

function guessExt(u) {
  const p = u.split("?")[0].toLowerCase();
  if (p.endsWith(".aac")) return ".aac";
  if (p.endsWith(".m4s")) return ".m4s";
  if (p.endsWith(".mp4")) return ".mp4";
  if (p.endsWith(".ts")) return ".ts";
  return ".ts";
}

function buildLocalM3U8(files, extinf) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (let i = 0; i < files.length; i++) {
    const d = Number.isFinite(extinf?.[i]) ? extinf[i] : 10.0;
    lines.push(`#EXTINF:${d.toFixed(3)},`);
    lines.push(files[i]);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

async function resolvePlaylist(url) {
  const masterText = await (
    await fetch(url, { credentials: "include" })
  ).text();
  if (/#EXT-X-STREAM-INF/i.test(masterText)) {
    const variants = [];
    const lines = masterText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].trim();
      if (L.startsWith("#EXT-X-STREAM-INF")) {
        const bw = Number(/BANDWIDTH=(\d+)/i.exec(L)?.[1] || "0");
        const next = lines[i + 1]?.trim();
        if (next && !next.startsWith("#")) {
          variants.push({ bw, url: new URL(next, url).toString() });
        }
      }
    }
    variants.sort((a, b) => b.bw - a.bw);
    const chosen = variants[0]?.url || url;
    return parseMedia(chosen);
  }
  return parseMedia(url);
}

async function parseMedia(mediaUrl) {
  const text = await (await fetch(mediaUrl, { credentials: "include" })).text();

  if (/#EXT-X-KEY/i.test(text)) {
    throw new Error("암호화(HLS KEY) 스트림은 현재 버전에서 미지원입니다.");
  }

  const base = new URL(mediaUrl);
  const segments = [];
  const extinf = [];
  const lines = text.split("\n");
  let lastDur = 10.0;
  for (const raw of lines) {
    const L = raw.trim();
    if (L.startsWith("#EXTINF:")) {
      const m = /^#EXTINF:([\d.]+)/.exec(L);
      lastDur = m ? parseFloat(m[1]) : 10.0;
    } else if (L && !L.startsWith("#")) {
      segments.push(new URL(L, base).toString());
      extinf.push(lastDur);
    }
  }
  return { segments, extinf };
}
