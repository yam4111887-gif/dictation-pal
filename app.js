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
  webRec.lang = "zh-TW";
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
      alert("麥克風權限被拒絕了——請在網址列的權限設定允許麥克風。");
      stopRecording();
    } else if (ev.error === "network") {
      alert("瀏覽器內建辨識需要網路連線。請改用「本機 Whisper」引擎（離線可用）。");
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

let localPipeline = null;
let mediaRecorder = null;
let audioChunks = [];

async function ensureLocalModel() {
  if (localPipeline) return localPipeline;
  els.modelProgress.textContent = "正在下載本機語音模型（首次約 80-150MB，之後有快取）…";
  const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1");
  env.allowLocalModels = false;
  const device = navigator.gpu ? "webgpu" : "wasm";
  localPipeline = await pipeline("automatic-speech-recognition", "onnx-community/whisper-base", {
    device,
    dtype: "q8",
    progress_callback: (p) => {
      if (p && p.status === "progress" && p.total) {
        els.modelProgress.textContent = `下載模型中… ${Math.round((p.loaded / p.total) * 100)}%`;
      }
    },
  });
  els.modelProgress.textContent = "✓ 本機模型已就緒（之後開啟不用重新下載）";
  return localPipeline;
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

async function localTranscribe(blob) {
  const asr = await ensureLocalModel();
  const audio = await blobToFloat32(blob);
  const out = await asr(audio, { language: "chinese", task: "transcribe" });
  return (out && out.text ? out.text : "").trim();
}

/* ---------- 引擎 3：BYOK API（OpenAI 相容 /audio/transcriptions） ---------- */

async function apiTranscribe(blob) {
  const s = loadSettings();
  if (!s.apiKey) throw new Error("尚未設定 API 金鑰");
  const fd = new FormData();
  fd.append("file", blob, "audio.webm");
  fd.append("model", s.model || "whisper-1");
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
      els.recState.textContent = engine === "local" ? "🔴 錄音中（本機，結束後轉錄）" : "🔴 錄音中（結束後送 API 轉錄）";
      els.recHint.textContent = "再點一次結束並開始轉錄。";
    }
  } catch (e) {
    recording = false;
    els.btnRec.classList.remove("recording");
    els.btnRec.textContent = "🎙️";
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
  els.btnRec.textContent = "🎙️";
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

  els.recState.textContent = "⏳ 轉錄中…（本機模型可能需要數十秒）";
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
    els.btnCopy.textContent = "✅ 已複製";
    setTimeout(() => (els.btnCopy.textContent = "📋 複製"), 1200);
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
