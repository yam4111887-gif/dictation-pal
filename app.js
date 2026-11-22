'use strict';
const REC_SVG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/></svg>';
const COPY_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
"use strict";

/* 聽寫俠 — 三引擎語音轉文字。全部在使用者瀏覽器執行，無後端。
   引擎：web=瀏覽器內建辨識／local=transformers.js 本機 Whisper／api=BYOK OpenAI 相容 */

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "dx-settings";
const HIST_KEY = "dx-history";

const els = {
  engines: [...document.querySelectorAll(".engine")],
  statusWeb: $("status-web"),
  statusLocal: $("status-local"),
  statusApi: $("status-api"),
  btnRec: $("btn-rec"),
  recState: $("rec-state"),
  recHint: $("rec-hint"),
  transcript: $("transcript"),
  interim: $("interim"),
  counter: $("counter"),
  modelProgress: $("model-progress"),
  btnCopy: $("btn-copy"),
  btnPunct: $("btn-punct"),
  btnDownload: $("btn-download"),
  btnClear: $("btn-clear"),
  histList: $("hist-list"),
  histEmpty: $("hist-empty"),
  dlgSettings: $("dlg-settings"),
};

let engine = "web";
let recording = false;

/* ---------- 辨識語言（多語言支援） ---------- */

/* speech=Web Speech API 的 BCP-47 代碼；whisper=transformers.js 語言名；api=OpenAI API ISO 碼（null=自動） */
const LANGS = {
  "zh-TW": { speech: "zh-TW", whisper: "chinese", api: "zh" },
  auto:    { speech: null,    whisper: null,      api: null },
  en:      { speech: "en-US", whisper: "english",  api: "en" },
  ja:      { speech: "ja-JP", whisper: "japanese", api: "ja" },
  ko:      { speech: "ko-KR", whisper: "korean",   api: "ko" },
  yue:     { speech: "zh-HK", whisper: "cantonese", api: null },
  vi:      { speech: "vi-VN", whisper: "vietnamese", api: "vi" },
  th:      { speech: "th-TH", whisper: "thai",     api: "th" },
  id:      { speech: "id-ID", whisper: "indonesian", api: "id" },
};

function currentLang() {
  const v = $("lang-select").value;
  return LANGS[v] ? v : "zh-TW";
}

$("lang-select").addEventListener("change", () => {
  const s = loadSettings();
  s.lang = currentLang();
  saveSettings(s);
});
(function initLang() {
  const saved = loadSettings().lang;
  if (saved && LANGS[saved]) $("lang-select").value = saved;
})();

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* ---------- 引擎狀態檢查 ---------- */

(function checkEngines() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    els.statusWeb.textContent = "✓ 可用（Chrome/Edge）";
    els.statusWeb.className = "status status-ok";
  } else {
    els.statusWeb.textContent = "✗ 此瀏覽器不支援（請改用 Chrome/Edge，或選其他引擎）";
    els.statusWeb.className = "status status-err";
    selectEngine("local");
  }

  if (navigator.gpu) {
    els.statusLocal.textContent = "✓ 可用（偵測到 WebGPU，速度較快）";
  } else {
    els.statusLocal.textContent = "△ 可用（無 WebGPU，用 CPU 跑，較慢但可用）";
  }

  /* 麥克風權限預檢（支援的瀏覽器才會回報） */
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions
      .query({ name: "microphone" })
      .then((p) => {
        if (p.state === "denied") {
          els.recHint.textContent = "⚠ 偵測到麥克風權限是「封鎖」狀態——請點網址列左邊的鎖頭允許麥克風，再重新整理。";
        }
      })
      .catch(() => { /* 不支援查詢的瀏覽器靜默略過 */ });
  }

  const s = loadSettings();
  if (s.apiKey) {
    els.statusApi.textContent = "✓ 已設定（點引擎卡片旁的 ⚙ 修改）";
    els.statusApi.className = "status status-ok";
  }
})();

/* ---------- 引擎選擇 ---------- */

function selectEngine(name) {
  engine = name;
  els.engines.forEach((el) => el.classList.toggle("selected", el.dataset.engine === name));
  if (name === "api" && !loadSettings().apiKey) {
    openSettings();
  }
}
els.engines.forEach((el) => el.addEventListener("click", () => selectEngine(el.dataset.engine)));

/* ---------- 設定對話框 ---------- */

function openSettings() {
  const s = loadSettings();
  $("set-endpoint").value = s.endpoint || "https://api.openai.com/v1";
  $("set-key").value = s.apiKey || "";
  $("set-model").value = s.model || "whisper-1";
  els.dlgSettings.showModal();
}
els.statusApi.addEventListener("click", openSettings);
$("btn-save-settings").addEventListener("click", () => {
  saveSettings({
    endpoint: $("set-endpoint").value.trim() || "https://api.openai.com/v1",
    apiKey: $("set-key").value.trim(),
    model: $("set-model").value.trim() || "whisper-1",
  });
  els.statusApi.textContent = "✓ 已設定";
  els.statusApi.className = "status status-ok";
  els.dlgSettings.close();
});
$("btn-close-settings").addEventListener("click", () => els.dlgSettings.close());

/* ---------- 引擎 1：瀏覽器內建（Web Speech API） ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let webRec = null;
let webFinalText = "";

function webStart() {
  webFinalText = els.transcript.value ? els.transcript.value.trimEnd() + "\n" : "";
  webRec = new SR();
  webRec.lang = LANGS[currentLang()].speech || navigator.language || "zh-TW";
  webRec.continuous = true;
  webRec.interimResults = true;
  webRec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) webFinalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    els.transcript.value = webFinalText;
    els.interim.textContent = interim;
    updateCounter();
  };
  webRec.onerror = (ev) => {
    if (ev.error === "not-allowed") {
      els.recState.textContent = "無法開始";
      els.recHint.textContent = "麥克風權限被拒絕——請點網址列左邊的鎖頭 → 允許麥克風，再試一次。";
      stopRecording();
    } else if (ev.error === "network") {
      els.recState.textContent = "已自動切換引擎";
      els.recHint.textContent = "瀏覽器內建辨識需要網路連線，已切換到「本機 Whisper」（離線可用）。請再按一次錄音。";
      selectEngine("local");
      stopRecording();
    }
    /* no-speech / aborted 靜默處理，由 onend 重啟邏輯接手 */
  };
  webRec.onend = () => {
    if (recording && engine === "web") {
      try { webRec.start(); } catch { /* 重啟競態，忽略 */ }
    }
  };
  webRec.start();
}

/* ---------- 引擎 2：本機 Whisper（transformers.js） ---------- */

/* 模型分級：Tiny（快）／Base（建議）。可各自快取，切換不會互相覆蓋。 */
const MODELS = {
  tiny: { id: "onnx-community/whisper-tiny", label: "Tiny" },
  base: { id: "onnx-community/whisper-base", label: "Base" },
};
const localPipelines = {};
let mediaRecorder = null;
let audioChunks = [];

function currentModelKey() {
  return loadSettings().localModel || "base";
}

document.querySelectorAll(".model-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    const k = btn.dataset.model;
    const s = loadSettings();
    s.localModel = k;
    saveSettings(s);
    document.querySelectorAll(".model-btn").forEach((b) => b.classList.toggle("selected", b.dataset.model === k));
    els.modelProgress.textContent =
      `已選 ${MODELS[k].label} 模型` + (localPipelines[MODELS[k].id] ? "（已就緒）" : "（下次錄音時下載）");
  })
);
document.querySelectorAll(".model-btn").forEach((b) => b.classList.toggle("selected", b.dataset.model === currentModelKey()));

async function ensureLocalModel() {
  const modelId = MODELS[currentModelKey()].id;
  if (localPipelines[modelId]) return localPipelines[modelId];
  els.modelProgress.textContent = `正在下載 ${currentModelKey() === "tiny" ? "Tiny（約 40MB" : "Base（約 80MB"}，首次較久，之後有快取）…`;
  const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1");
  env.allowLocalModels = false;
  const device = navigator.gpu ? "webgpu" : "wasm";
  localPipelines[modelId] = await pipeline("automatic-speech-recognition", modelId, {
    device,
    dtype: "q8",
    progress_callback: (p) => {
      if (p && p.status === "progress" && p.total) {
        els.modelProgress.textContent = `下載模型中… ${Math.round((p.loaded / p.total) * 100)}%`;
      }
    },
  });
  els.modelProgress.textContent = "✓ 本機模型已就緒（之後開啟不用重新下載）";
  return localPipelines[modelId];
}

async function blobToFloat32(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(buf);
  await ctx.close();
  /* 混合為單聲道 */
  const chs = decoded.numberOfChannels;
  if (chs === 1) return decoded.getChannelData(0);
  const a = decoded.getChannelData(0);
  const b = decoded.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

/* 長音訊分段轉錄：每段 30 秒，避免一次餵太長導致當機或幻覺 */
function whisperOpts() {
  const w = LANGS[currentLang()].whisper;
  return w ? { language: w, task: "transcribe" } : { task: "transcribe" }; /* null=自動偵測 */
}

async function localTranscribe(blob) {
  const asr = await ensureLocalModel();
  const audio = await blobToFloat32(blob);
  const CHUNK = 16000 * 30;
  const opts = whisperOpts();
  if (audio.length <= CHUNK) {
    const out = await asr(audio, opts);
    return (out && out.text ? out.text : "").trim();
  }
  const total = Math.ceil(audio.length / CHUNK);
  const parts = [];
  for (let i = 0; i < total; i++) {
    els.recState.textContent = `⏳ 轉錄中… 第 ${i + 1}/${total} 段`;
    const seg = audio.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, audio.length));
    const out = await asr(seg, opts);
    if (out && out.text) parts.push(out.text.trim());
  }
  return parts.join("\n");
}

/* ---------- 引擎 3：BYOK API（OpenAI 相容 /audio/transcriptions） ---------- */

async function apiTranscribe(blob) {
  const s = loadSettings();
  if (!s.apiKey) throw new Error("尚未設定 API 金鑰");
  const fd = new FormData();
  fd.append("file", blob, "audio.webm");
  fd.append("model", s.model || "whisper-1");
  const apiLang = LANGS[currentLang()].api;
  if (apiLang) fd.append("language", apiLang);
  const res = await fetch((s.endpoint || "https://api.openai.com/v1").replace(/\/+$/, "") + "/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API 錯誤 ${res.status}：${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.text || "").trim();
}

/* ---------- 錄音主流程 ---------- */

function startMicRecording() {
  return navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) audioChunks.push(e.data);
    };
    mediaRecorder.start(1000);
    return stream;
  });
}

function stopMicRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve(null);
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" }));
    };
    mediaRecorder.stop();
  });
}

async function toggleRecording() {
  if (recording) {
    await stopRecording();
    return;
  }
  recording = true;
  els.btnRec.classList.add("recording");
  els.btnRec.textContent = "⏹";
  els.interim.textContent = "";
  try {
    if (engine === "web") {
      webStart();
      els.recState.textContent = "🔴 錄音中（即時辨識）";
      els.recHint.textContent = "再點一次結束。說話之間停頓沒關係，會自動繼續。";
    } else {
      await startMicRecording();
      els.recState.textContent = engine === "local" ? "錄音中（本機，結束後轉錄）" : "錄音中（結束後送 API 轉錄）";
      els.recHint.textContent = "再點一次結束並開始轉錄。";
    }
  } catch (e) {
    recording = false;
    els.btnRec.classList.remove("recording");
    els.btnRec.innerHTML = REC_SVG;
    els.recState.textContent = "無法開始";
    els.recHint.textContent = String(e.message || e);
    if (String(e.name) === "NotAllowedError") {
      els.recHint.textContent = "麥克風權限被拒絕——請在網址列權限設定允許後再試。";
    }
  }
}

async function stopRecording() {
  recording = false;
  els.btnRec.classList.remove("recording");
  els.btnRec.innerHTML = REC_SVG;
  els.interim.textContent = "";

  if (engine === "web") {
    if (webRec) {
      try { webRec.stop(); } catch { }
      webRec = null;
    }
    els.recState.textContent = "完成";
    saveHistory();
    return;
  }

  els.recState.textContent = "轉錄中…（本機模型可能需要數十秒）";
  try {
    const blob = await stopMicRecording();
    if (!blob || !blob.size) throw new Error("沒有錄到聲音");
    const text = engine === "local" ? await localTranscribe(blob) : await apiTranscribe(blob);
    if (text) {
      els.transcript.value = els.transcript.value ? els.transcript.value.trimEnd() + "\n" + text : text;
      updateCounter();
      saveHistory();
    }
    els.recState.textContent = "完成";
  } catch (e) {
    els.recState.textContent = "轉錄失敗";
    els.recHint.textContent = String(e.message || e);
  }
}

els.btnRec.addEventListener("click", toggleRecording);

/* ---------- 文字工具 ---------- */

function updateCounter() {
  const n = els.transcript.value.replace(/\s/g, "").length;
  els.counter.textContent = `${n} 字`;
}
els.transcript.addEventListener("input", updateCounter);

els.btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.transcript.value);
    els.btnCopy.innerHTML = CHECK_SVG + " 已複製";
    setTimeout(() => (els.btnCopy.innerHTML = COPY_SVG + " 複製"), 1200);
  } catch {
    alert("複製失敗，請手動選取。");
  }
});

els.btnDownload.addEventListener("click", () => {
  const blob = new Blob([els.transcript.value], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `聽寫-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.btnClear.addEventListener("click", () => {
  els.transcript.value = "";
  els.interim.textContent = "";
  updateCounter();
});

/* 標點整理：規則式後處理（詞句間距、句讀） */
els.btnPunct.addEventListener("click", () => {
  let t = els.transcript.value;
  if (!t.trim()) return;
  t = t.replace(/\s+/g, " ").trim();
  /* 中英之間補空格 */
  t = t.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, "$1 $2").replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, "$1 $2");
  /* 常見連接詞前斷句 */
  t = t.replace(/\s*(然後|接著|另外|最後|所以|但是|不過|因此)\s*/g, "，$1");
  /* 過長無標點句：每 35 字左右補句號（僅在無任何標點時） */
  if (!/[。，、！？,.!?]/.test(t)) {
    t = t.replace(/(.{30,40}?)\s/g, "$1。");
  }
  t = t.replace(/^，/, "").replace(/，+/g, "，").replace(/。+/g, "。");
  if (!/[。！？.!?]$/.test(t)) t += "。";
  els.transcript.value = t;
  updateCounter();
});

/* ---------- 歷史 ---------- */

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory() {
  const text = els.transcript.value.trim();
  if (!text) return;
  const h = loadHistory();
  h.unshift({ ts: new Date().toISOString(), engine, text: text.slice(0, 5000) });
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 30)));
  renderHistory();
}

function renderHistory() {
  const h = loadHistory();
  els.histEmpty.hidden = h.length > 0;
  els.histList.innerHTML = "";
  for (const e of h) {
    const div = document.createElement("div");
    div.className = "hist-item";
    const d = new Date(e.ts);
    const label = { web: "瀏覽器", local: "本機", api: "API" }[e.engine] || e.engine;
    div.innerHTML = `
      <span class="preview">${e.text.slice(0, 60).replace(/</g, "&lt;")}</span>
      <span class="meta">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}・${label}</span>
      <span class="op"><button class="ghost" title="載入全文">載入</button></span>`;
    div.querySelector("button").addEventListener("click", () => {
      els.transcript.value = e.text;
      updateCounter();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    els.histList.appendChild(div);
  }
}

updateCounter();
renderHistory();
