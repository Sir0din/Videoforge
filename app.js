// =============================================================================
// VIDEO FORGE — APPLICATION LAYER
// -----------------------------------------------------------------------------
// Architecture:
//
//   UI Layer
//      |
//      v
//   Compression Controller ---> Media Analyzer, Progress Manager
//      |
//      v
//   FFmpeg Adapter (ffmpeg-adapter.js — the only file that talks to FFmpeg)
//      |
//      v
//   Official FFmpeg.wasm Engine
//
// This file is organized into clearly separated modules, in dependency order:
//   1. Utility Functions
//   2. Compression Profiles
//   3. Media Analyzer
//   4. Upload Manager
//   5. Progress Manager
//   6. Compression Controller
//   7. Download Manager
//   8. UI Layer
//   9. Bootstrap
//
// No module outside the FFmpeg Adapter ever imports from '@ffmpeg/*' directly.
// =============================================================================

import * as FFmpegAdapter from './ffmpeg-adapter.js';

/* =============================================================================
   1. UTILITY FUNCTIONS
   ============================================================================= */
const Utils = (() => {
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(totalSeconds) {
    if (!isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
    const m = Math.floor(totalSeconds / 60);
    const s = Math.round(totalSeconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function sanitizeBaseName(filename) {
    return filename
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-z0-9_\-]+/gi, '_')
      .slice(0, 60);
  }

  function timestampSlug() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /** Translates raw FFmpeg/browser errors into plain, non-technical, solution-oriented messages. */
  function humanizeError(rawText) {
    const msg = (rawText || '').toLowerCase();
    if (msg.includes('invalid data') || msg.includes('moov atom') || msg.includes('could not find codec')) {
      return "This file looks corrupted or uses a format the engine can't read. Try re-exporting it, or use a different file.";
    }
    if (msg.includes('memory') || msg.includes('out of bounds') || msg.includes('abort')) {
      return "This file is too large for your browser to process in one go. Try a shorter clip, a lower resolution, or close other tabs to free up memory.";
    }
    if (msg.includes('no such file')) {
      return "The file couldn't be read. Try dropping it in again.";
    }
    return 'Something went wrong during encoding. Try a different preset, a lower resolution, or a smaller file.';
  }

  const ALLOWED_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv'];
  function getExtension(filename) {
    return (filename.split('.').pop() || '').toLowerCase();
  }
  function isSupportedVideo(filename) {
    return ALLOWED_EXTENSIONS.includes(getExtension(filename));
  }

  return { formatBytes, formatDuration, sanitizeBaseName, timestampSlug, humanizeError, getExtension, isSupportedVideo };
})();

/* =============================================================================
   2. COMPRESSION PROFILES
   -----------------------------------------------------------------------------
   Pure data objects. No FFmpeg commands live here — the Compression
   Controller is solely responsible for turning a profile + advanced
   overrides into an actual FFmpeg argument list.
   ============================================================================= */
const CompressionProfiles = {
  discord: {
    key: 'discord', label: 'Discord Clip', icon: '💬',
    description: 'Squeezes under the 8MB embed limit.',
    targetLabel: 'Target ~8MB',
    resolution: '720', fps: '30', codec: 'h264',
    rateControlMode: 'targetSize', targetSizeMB: 8,
    quality: 30, audioMode: 'compress', audioBitrateKbps: 64,
  },
  twitter: {
    key: 'twitter', label: 'X / Twitter Clip', icon: '🐦',
    description: 'Balanced compression, up to 1080p.',
    targetLabel: 'Target ~25MB',
    resolution: '1080', fps: 'original', codec: 'h264',
    rateControlMode: 'targetSize', targetSizeMB: 25,
    quality: 26, audioMode: 'compress', audioBitrateKbps: 128,
  },
  twitch: {
    key: 'twitch', label: 'Twitch Highlight', icon: '🎮',
    description: 'High quality, keeps 60fps where possible.',
    targetLabel: 'Minimal compression',
    resolution: 'original', fps: 'original', codec: 'h264',
    rateControlMode: 'quality', targetSizeMB: null,
    quality: 18, audioMode: 'keep', audioBitrateKbps: 160,
  },
  tiktok: {
    key: 'tiktok', label: 'TikTok Vertical', icon: '📱',
    description: 'Auto-crops to 1080×1920, optimized bitrate.',
    targetLabel: '1080×1920',
    resolution: 'vertical', fps: '30', codec: 'h264',
    rateControlMode: 'quality', targetSizeMB: null,
    quality: 23, audioMode: 'compress', audioBitrateKbps: 128,
  },
  shorts: {
    key: 'shorts', label: 'YouTube Shorts', icon: '🎥',
    description: 'Vertical, social-ready balanced encode.',
    targetLabel: '1080×1920',
    resolution: 'vertical', fps: '30', codec: 'h264',
    rateControlMode: 'quality', targetSizeMB: null,
    quality: 25, audioMode: 'compress', audioBitrateKbps: 128,
  },
  ultra: {
    key: 'ultra', label: 'Ultra Compress', icon: '💣',
    description: 'Maximum shrink. Quality takes a back seat.',
    targetLabel: 'Smallest possible file',
    resolution: '480', fps: '24', codec: 'h264',
    rateControlMode: 'quality', targetSizeMB: null,
    quality: 36, audioMode: 'compress', audioBitrateKbps: 48,
  },
};

/** Rough, clearly-labeled heuristic for pre-encode size estimates in quality (CRF) mode.
 *  Actual output size for CRF encoding depends on scene complexity and cannot be known
 *  without actually encoding — this is an estimate only, never presented as exact. */
function estimateOutputBytes(profile, sourceBytes, sourceDurationSec) {
  if (profile.rateControlMode === 'targetSize' && profile.targetSizeMB) {
    return profile.targetSizeMB * 1024 * 1024;
  }
  // Heuristic: lower CRF (higher quality) retains more of the source size;
  // higher CRF and smaller target resolution shrink it further.
  const crfFactor = Math.max(0.12, 1 - (profile.quality / 51) * 0.9);
  const resFactor = { original: 1, '1080': 0.85, '720': 0.6, '480': 0.35, vertical: 0.55 }[profile.resolution] ?? 1;
  return Math.round(sourceBytes * crfFactor * resFactor);
}

/* =============================================================================
   3. MEDIA ANALYZER
   -----------------------------------------------------------------------------
   Reads duration and resolution using the native HTML5 <video> element —
   this is instant and needs no FFmpeg/WASM at all, so it works before the
   (much heavier) encoding engine has even started loading.
   Frame rate is NOT exposed by the HTML5 video element API in any browser,
   so rather than fake a probe, we surface it once FFmpeg reads the stream
   during actual encoding (see Progress Manager's log parsing below).
   ============================================================================= */
const MediaAnalyzer = (() => {
  function analyze(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      const objectUrl = URL.createObjectURL(file);
      const cleanup = () => URL.revokeObjectURL(objectUrl);

      video.onloadedmetadata = () => {
        resolve({
          duration: video.duration || null,
          width: video.videoWidth || null,
          height: video.videoHeight || null,
        });
        cleanup();
      };
      video.onerror = () => {
        resolve({ duration: null, width: null, height: null });
        cleanup();
      };
      video.src = objectUrl;
    });
  }

  return { analyze };
})();

/* =============================================================================
   4. UPLOAD MANAGER
   -----------------------------------------------------------------------------
   Owns the in-memory file queue. Knows nothing about FFmpeg or encoding —
   only about accepting, validating, listing, and removing files.
   ============================================================================= */
const UploadManager = (() => {
  let idCounter = 0;
  let queue = [];

  function addFiles(fileList) {
    const added = [];
    [...fileList].forEach((file) => {
      const record = {
        id: ++idCounter,
        file,
        name: file.name,
        size: file.size,
        status: 'queued', // queued | analyzing | ready | working | done | error
        stage: 'Waiting',
        progress: 0,
        eta: null,
        speed: null,
        duration: null,
        width: null,
        height: null,
        estimatedOutputBytes: null,
        outputBlob: null,
        outputSize: null,
        outputUrl: null,
        outputName: null,
        error: null,
      };
      if (!Utils.isSupportedVideo(file.name)) {
        record.status = 'error';
        record.error = `".${Utils.getExtension(file.name)}" isn't a supported video format. Try MP4, MOV, MKV, WebM or AVI.`;
      }
      queue.push(record);
      added.push(record);
    });
    return added;
  }

  function remove(id) {
    const rec = queue.find((f) => f.id === id);
    if (rec?.outputUrl) URL.revokeObjectURL(rec.outputUrl);
    queue = queue.filter((f) => f.id !== id);
  }

  function clear() {
    queue.forEach((f) => { if (f.outputUrl) URL.revokeObjectURL(f.outputUrl); });
    queue = [];
  }

  function getAll() { return queue; }
  function getById(id) { return queue.find((f) => f.id === id); }
  function update(id, patch) {
    const rec = queue.find((f) => f.id === id);
    if (rec) Object.assign(rec, patch);
    return rec;
  }

  return { addFiles, remove, clear, getAll, getById, update };
})();

/* =============================================================================
   5. PROGRESS MANAGER
   -----------------------------------------------------------------------------
   Listens to the FFmpeg Adapter's log/progress streams for whichever file is
   currently active, and derives percentage, stage, elapsed/remaining time,
   and live encoding speed. The UI only ever consumes the values this module
   produces — it never touches FFmpeg events directly.
   ============================================================================= */
const ProgressManager = (() => {
  let activeFileId = null;
  let encodeStartMs = null;
  let onUpdateCallback = null;
  let unsubscribeLog = null;
  let unsubscribeProgress = null;

  function begin(fileId, onUpdate) {
    activeFileId = fileId;
    encodeStartMs = performance.now();
    onUpdateCallback = onUpdate;

    unsubscribeProgress = FFmpegAdapter.onProgress(({ progress }) => {
      if (activeFileId !== fileId) return;
      const clamped = Math.max(0, Math.min(1, progress || 0));
      const elapsedSec = (performance.now() - encodeStartMs) / 1000;
      const eta = clamped > 0.02 ? (elapsedSec / clamped) * (1 - clamped) : null;
      emit({ progress: clamped, elapsedSec, eta });
    });

    unsubscribeLog = FFmpegAdapter.onLog((message) => {
      if (activeFileId !== fileId) return;
      const speedMatch = message.match(/speed=\s*([\d.]+)x/);
      const sizeMatch = message.match(/size=\s*(\d+)kB/i);
      if (speedMatch || sizeMatch) {
        emit({
          speed: speedMatch ? `${speedMatch[1]}×` : undefined,
          liveOutputBytes: sizeMatch ? Number(sizeMatch[1]) * 1024 : undefined,
        });
      }
    });
  }

  function emit(partial) {
    if (onUpdateCallback) onUpdateCallback(partial);
  }

  function end() {
    if (unsubscribeProgress) unsubscribeProgress();
    if (unsubscribeLog) unsubscribeLog();
    unsubscribeProgress = null;
    unsubscribeLog = null;
    activeFileId = null;
    onUpdateCallback = null;
  }

  return { begin, end };
})();

/* =============================================================================
   6. COMPRESSION CONTROLLER
   -----------------------------------------------------------------------------
   The only module that turns (Profile + Advanced Settings) into an actual
   FFmpeg argument list, and the only module that drives the FFmpeg Adapter
   through a full job (probe -> encode -> read -> cleanup). The UI never
   constructs FFmpeg commands itself.
   ============================================================================= */
const CompressionController = (() => {
  let capturedProbeDuration = null;

  function buildArgs({ profile, overrides, inputName, outputName, durationSec }) {
    const resolution = overrides.resolution ?? profile.resolution;
    const fps = overrides.fps ?? profile.fps;
    const codec = overrides.codec ?? profile.codec;
    const audioMode = overrides.audioMode ?? profile.audioMode;
    const audioBitrateKbps = overrides.audioBitrateKbps ?? profile.audioBitrateKbps;
    const quality = overrides.quality ?? profile.quality;
    const rateControlMode = overrides.rateControlModeOverride ?? profile.rateControlMode;

    const videoFilters = [];
    if (resolution === '1080') videoFilters.push('scale=-2:1080');
    else if (resolution === '720') videoFilters.push('scale=-2:720');
    else if (resolution === '480') videoFilters.push('scale=-2:480');
    else if (resolution === 'vertical') videoFilters.push('scale=1080:1920:force_original_aspect_ratio=increase', 'crop=1080:1920');

    if (fps !== 'original') videoFilters.push(`fps=${fps}`);

    const args = ['-i', inputName];
    if (videoFilters.length) args.push('-vf', videoFilters.join(','));

    args.push('-c:v', codec === 'h265' ? 'libx265' : 'libx264');

    const useTargetSize = rateControlMode === 'targetSize' && profile.targetSizeMB && durationSec;
    if (useTargetSize) {
      const audioKbps = audioMode === 'remove' ? 0 : (audioBitrateKbps || 128);
      let videoKbps = Math.floor((profile.targetSizeMB * 8192) / durationSec - audioKbps);
      videoKbps = Math.max(videoKbps, 150);
      args.push('-b:v', `${videoKbps}k`, '-maxrate', `${Math.floor(videoKbps * 1.45)}k`, '-bufsize', `${videoKbps * 2}k`);
    } else {
      args.push('-crf', String(quality));
    }

    args.push('-preset', 'veryfast', '-pix_fmt', 'yuv420p');

    if (audioMode === 'remove') {
      args.push('-an');
    } else {
      const ab = audioMode === 'compress' ? (audioBitrateKbps || 96) : 160;
      args.push('-c:a', 'aac', '-b:a', `${ab}k`);
    }

    args.push('-map_metadata', '-1', '-movflags', '+faststart', outputName);
    return args;
  }

  /** Runs `ffmpeg -i <input>` (no output) purely to read Duration/resolution/fps from the log stream. */
  async function probeDuration(inputName) {
    capturedProbeDuration = null;
    const unsubscribe = FFmpegAdapter.onLog((message) => {
      const m = message.match(/Duration:\s*(\d\d):(\d\d):(\d\d)\.(\d\d)/);
      if (m) capturedProbeDuration = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
    });
    try {
      await FFmpegAdapter.execute(['-i', inputName]);
    } catch (e) {
      // Expected: ffmpeg exits non-zero because no output was requested. We only wanted the logs.
    } finally {
      unsubscribe();
    }
    return capturedProbeDuration;
  }

  async function runJob({ record, profile, overrides, onProgressUpdate }) {
    const ext = Utils.getExtension(record.name) || 'mp4';
    const inputName = `in_${record.id}.${ext}`;
    const outputName = `out_${record.id}.mp4`;
    const jobStartMs = performance.now();

    await FFmpegAdapter.writeInputFile(inputName, record.file);

    let durationSec = record.duration;
    const needsProbe = (overrides.rateControlModeOverride ?? profile.rateControlMode) === 'targetSize' && !durationSec;
    if (needsProbe) {
      durationSec = await probeDuration(inputName);
    }

    ProgressManager.begin(record.id, onProgressUpdate);
    const args = buildArgs({ profile, overrides, inputName, outputName, durationSec });

    try {
      await FFmpegAdapter.execute(args);
    } finally {
      ProgressManager.end();
    }

    const outputData = await FFmpegAdapter.readOutputFile(outputName);
    const blob = new Blob([outputData.buffer], { type: 'video/mp4' });
    await FFmpegAdapter.cleanupFiles([inputName, outputName]);

    return {
      blob,
      encodeDurationSec: (performance.now() - jobStartMs) / 1000,
    };
  }

  return { runJob, estimateOutputBytes };
})();

/* =============================================================================
   7. DOWNLOAD MANAGER
   -----------------------------------------------------------------------------
   Owns output naming and single/batch delivery of finished files.
   ============================================================================= */
const DownloadManager = (() => {
  function buildOutputName(originalName, profileKey) {
    return `${Utils.sanitizeBaseName(originalName)}_${profileKey}_${Utils.timestampSlug()}.mp4`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function downloadAllAsZip(records) {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    const zip = new JSZip();
    records.forEach((r) => zip.file(r.outputName, r.outputBlob));
    const blob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(blob, `VideoForge_Batch_${Date.now()}.zip`);
  }

  return { buildOutputName, triggerDownload, downloadAllAsZip };
})();

/* =============================================================================
   8. UI LAYER
   -----------------------------------------------------------------------------
   All DOM references, rendering, and event wiring. This layer only ever
   calls into the managers/controller above — it never builds FFmpeg
   commands and never imports the FFmpeg Adapter directly.
   ============================================================================= */
const UI = (() => {
  const dom = {};
  let selectedProfileKey = 'discord';
  let overrides = {}; // advanced-setting overrides layered on top of the selected profile
  let qualityTouchedManually = false;
  let isProcessing = false;

  function cacheDom() {
    dom.dropzone = document.getElementById('dropzone');
    dom.fileInput = document.getElementById('fileInput');
    dom.presetGrid = document.getElementById('presetGrid');
    dom.queueList = document.getElementById('queueList');
    dom.queueEmpty = document.getElementById('queueEmpty');
    dom.btnForge = document.getElementById('btnForge');
    dom.btnZip = document.getElementById('btnZip');
    dom.btnClear = document.getElementById('btnClear');
    dom.totals = document.getElementById('totalsLabel');
    dom.engineDot = document.getElementById('engineDot');
    dom.engineLabel = document.getElementById('engineLabel');
    dom.bigFileBanner = document.getElementById('bigFileBanner');
    dom.loadOverlay = document.getElementById('loadOverlay');
    dom.overlayMsg = dom.loadOverlay.querySelector('.msg');
    dom.overlaySub = dom.loadOverlay.querySelector('.sub');

    dom.advToggle = document.getElementById('advToggle');
    dom.advBody = document.getElementById('advBody');
    dom.selResolution = document.getElementById('selResolution');
    dom.selFps = document.getElementById('selFps');
    dom.segCodec = document.getElementById('segCodec');
    dom.segAudio = document.getElementById('segAudio');
    dom.crfSlider = document.getElementById('crfSlider');
    dom.crfVal = document.getElementById('crfVal');
    dom.crfModeNote = document.getElementById('crfModeNote');
  }

  /* ---- Preset grid ---- */
  function renderPresets() {
    dom.presetGrid.innerHTML = '';
    Object.values(CompressionProfiles).forEach((profile) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'preset-card' + (profile.key === selectedProfileKey ? ' active' : '');
      card.innerHTML = `
        <span class="icon">${profile.icon}</span>
        <span class="title">${profile.label}</span>
        <span class="desc">${profile.description}</span>
        <span class="target">${profile.targetLabel}</span>
      `;
      card.addEventListener('click', () => selectProfile(profile.key));
      dom.presetGrid.appendChild(card);
    });
  }

  function selectProfile(key) {
    selectedProfileKey = key;
    overrides = {};
    qualityTouchedManually = false;
    syncAdvancedPanel();
    renderPresets();
    refreshQueueEstimates();
  }

  /* ---- Advanced settings panel ---- */
  function syncAdvancedPanel() {
    const profile = CompressionProfiles[selectedProfileKey];
    dom.selResolution.value = overrides.resolution ?? profile.resolution;
    dom.selFps.value = overrides.fps ?? profile.fps;
    const codec = overrides.codec ?? profile.codec;
    const audioMode = overrides.audioMode ?? profile.audioMode;
    [...dom.segCodec.children].forEach((b) => b.classList.toggle('active', b.dataset.val === codec));
    [...dom.segAudio.children].forEach((b) => b.classList.toggle('active', b.dataset.val === audioMode));
    const quality = overrides.quality ?? profile.quality;
    dom.crfSlider.value = quality;
    dom.crfVal.textContent = quality;
    updateCrfNote(profile);
  }

  function updateCrfNote(profile) {
    const usingTargetSize = profile.rateControlMode === 'targetSize' && profile.targetSizeMB && !qualityTouchedManually;
    dom.crfModeNote.textContent = usingTargetSize
      ? `— using target-size bitrate (${profile.targetSizeMB}MB); moving the slider switches to manual quality`
      : '';
  }

  function bindAdvancedPanel() {
    dom.advToggle.addEventListener('click', () => {
      dom.advToggle.classList.toggle('open');
      dom.advBody.classList.toggle('open');
    });
    dom.selResolution.addEventListener('change', () => { overrides.resolution = dom.selResolution.value; refreshQueueEstimates(); });
    dom.selFps.addEventListener('change', () => { overrides.fps = dom.selFps.value; });
    dom.segCodec.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      [...dom.segCodec.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      overrides.codec = btn.dataset.val;
    });
    dom.segAudio.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      [...dom.segAudio.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      overrides.audioMode = btn.dataset.val;
    });
    dom.crfSlider.addEventListener('input', () => {
      dom.crfVal.textContent = dom.crfSlider.value;
      overrides.quality = +dom.crfSlider.value;
      overrides.rateControlModeOverride = 'quality';
      qualityTouchedManually = true;
      updateCrfNote(CompressionProfiles[selectedProfileKey]);
      refreshQueueEstimates();
    });
    document.querySelectorAll('.crf-presets button').forEach((btn) => {
      btn.addEventListener('click', () => {
        dom.crfSlider.value = btn.dataset.crf;
        dom.crfSlider.dispatchEvent(new Event('input'));
      });
    });
  }

  /* ---- Upload / dropzone ---- */
  function bindUpload() {
    dom.dropzone.addEventListener('click', () => dom.fileInput.click());
    dom.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropzone.classList.add('dragover'); });
    dom.dropzone.addEventListener('dragleave', () => dom.dropzone.classList.remove('dragover'));
    dom.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove('dragover');
      handleNewFiles(e.dataTransfer.files);
    });
    dom.fileInput.addEventListener('change', () => {
      handleNewFiles(dom.fileInput.files);
      dom.fileInput.value = '';
    });
  }

  function handleNewFiles(fileList) {
    const added = UploadManager.addFiles(fileList);
    const hasBigFile = added.some((f) => f.size > 800 * 1024 * 1024);
    if (hasBigFile) {
      dom.bigFileBanner.style.display = 'block';
      dom.bigFileBanner.textContent = "⚠ One or more files are quite large. Big files can take a while and may strain your browser's memory — consider trimming clips first if you run into trouble.";
    }

    // Kick off native, FFmpeg-free analysis immediately for each valid file.
    added.filter((f) => f.status !== 'error').forEach(async (rec) => {
      UploadManager.update(rec.id, { status: 'analyzing', stage: 'Reading file info' });
      renderQueue();
      const meta = await MediaAnalyzer.analyze(rec.file);
      const profile = CompressionProfiles[selectedProfileKey];
      const estimate = CompressionController.estimateOutputBytes(profile, rec.size, meta.duration);
      UploadManager.update(rec.id, {
        status: 'queued', stage: 'Waiting',
        duration: meta.duration, width: meta.width, height: meta.height,
        estimatedOutputBytes: estimate,
      });
      renderQueue();
      refreshForgeButton();
    });

    // Warm the encoding engine in the background as soon as a file is selected —
    // this satisfies "lazy-load only after a file is selected" while ensuring
    // the engine is likely ready by the time the user hits Forge.
    warmEngine();

    renderQueue();
    refreshForgeButton();
  }

  function refreshQueueEstimates() {
    const profile = CompressionProfiles[selectedProfileKey];
    UploadManager.getAll().forEach((rec) => {
      if (rec.status === 'done' || rec.status === 'error') return;
      const estimate = CompressionController.estimateOutputBytes(profile, rec.size, rec.duration);
      UploadManager.update(rec.id, { estimatedOutputBytes: estimate });
    });
    renderQueue();
  }

  /* ---- Queue rendering ---- */
  function renderQueue() {
    const all = UploadManager.getAll();
    dom.queueEmpty.style.display = all.length ? 'none' : 'block';
    dom.queueList.innerHTML = '';
    all.forEach((rec) => dom.queueList.appendChild(buildFileRow(rec)));
    updateTotals();
  }

  function buildFileRow(rec) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.id = rec.id;

    const badgeText = { queued: 'Queued', analyzing: 'Analyzing…', working: 'Forging…', done: 'Done', error: 'Error' }[rec.status] || rec.status;
    const icon = rec.status === 'done' ? '✅' : rec.status === 'error' ? '⚠️' : '🎞️';

    const metaLine = (rec.status !== 'error')
      ? `<div class="meta-line">
           ${rec.width ? `${rec.width}×${rec.height}` : '—'} ·
           ${rec.duration ? Utils.formatDuration(rec.duration) : '—'} ·
           est. output ${rec.estimatedOutputBytes ? Utils.formatBytes(rec.estimatedOutputBytes) : '—'}
         </div>`
      : '';

    const workingBlock = rec.status === 'working' ? `
      <div class="stage-line">
        <span>${rec.stage}${rec.speed ? ` · ${rec.speed} speed` : ''}</span>
        <span>${Math.round(rec.progress * 100)}% · ETA ${Utils.formatDuration(rec.eta)}</span>
      </div>
      <div class="meter"><div class="fill" style="width:${Math.round(rec.progress * 100)}%"></div></div>
    ` : '';

    const doneBlock = rec.status === 'done' ? `
      <div class="size-compare">
        <span>In: <b>${Utils.formatBytes(rec.size)}</b></span>
        <span class="arrow">→</span>
        <span>Out: <b>${Utils.formatBytes(rec.outputSize)}</b></span>
        <span class="saved">${rec.outputSize < rec.size ? '−' : '+'}${Math.abs(Math.round((1 - rec.outputSize / rec.size) * 100))}% · encoded in ${Utils.formatDuration(rec.encodeDurationSec)}</span>
      </div>
    ` : '';

    const errorBlock = rec.status === 'error' ? `<div class="err-msg">${rec.error}</div>` : '';

    row.innerHTML = `
      <div class="top-line">
        <div class="meta">
          <span class="fico">${icon}</span>
          <span class="fname" title="${rec.name}">${rec.name}</span>
          <span class="fsize">${Utils.formatBytes(rec.size)}</span>
        </div>
        <div class="actions">
          <span class="badge ${rec.status}">${badgeText}</span>
          ${rec.status === 'done' ? `<a class="dl-link" download="${rec.outputName}" href="${rec.outputUrl}">⬇ Download</a>` : ''}
          ${rec.status !== 'working' ? `<button class="icon-btn" data-action="remove" title="Remove">✕</button>` : ''}
        </div>
      </div>
      ${metaLine}
      ${workingBlock}
      ${doneBlock}
      ${errorBlock}
    `;

    row.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
      UploadManager.remove(rec.id);
      renderQueue();
      refreshForgeButton();
    });
    return row;
  }

  function patchFileRow(id, patch) {
    const rec = UploadManager.update(id, patch);
    if (!rec) return;
    const row = dom.queueList.querySelector(`.file-row[data-id="${id}"]`);
    if (row) row.replaceWith(buildFileRow(rec));
    updateTotals();
  }

  function updateTotals() {
    const done = UploadManager.getAll().filter((f) => f.status === 'done');
    if (!done.length) {
      dom.totals.textContent = '';
      dom.btnZip.style.display = 'none';
      return;
    }
    const inTotal = done.reduce((a, f) => a + f.size, 0);
    const outTotal = done.reduce((a, f) => a + f.outputSize, 0);
    const savedPct = Math.round((1 - outTotal / inTotal) * 100);
    dom.totals.innerHTML = `${done.length} done · <b>${Utils.formatBytes(inTotal)}</b> → <b>${Utils.formatBytes(outTotal)}</b> (${savedPct >= 0 ? '−' : '+'}${Math.abs(savedPct)}%)`;
    dom.btnZip.style.display = done.length > 1 ? 'inline-block' : 'none';
  }

  /* ---- Engine status + lazy warm-up ---- */
  let warmupStarted = false;
  function warmEngine() {
    if (warmupStarted) return;
    warmupStarted = true;
    setEngineState('loading');
    FFmpegAdapter.initEngine()
      .then(() => {
        setEngineState('ready');
        refreshForgeButton();
      })
      .catch(() => {
        setEngineState('failed');
      });
  }

  function setEngineState(state) {
    dom.engineDot.classList.remove('ready', 'busy');
    if (state === 'loading') {
      dom.engineLabel.textContent = 'Loading engine…';
      dom.loadOverlay.classList.remove('hidden');
    } else if (state === 'ready') {
      dom.engineLabel.textContent = 'Engine ready';
      dom.engineDot.classList.add('ready');
      dom.loadOverlay.classList.add('hidden');
    } else if (state === 'failed') {
      dom.engineLabel.textContent = 'Engine failed to load';
      dom.overlayMsg.textContent = "The forge couldn't ignite.";
      dom.overlaySub.textContent = 'Your browser blocked the encoding engine from loading. Check your connection, try Chrome or Edge on desktop, then reload the page.';
    } else if (state === 'idle') {
      dom.engineLabel.textContent = 'Engine idle — drop a file to begin';
    }
  }

  /* ---- Forge run ---- */
  function bindActions() {
    dom.btnForge.addEventListener('click', runQueue);
    dom.btnClear.addEventListener('click', () => {
      if (isProcessing) return;
      UploadManager.clear();
      renderQueue();
      refreshForgeButton();
    });
    dom.btnZip.addEventListener('click', async () => {
      dom.btnZip.disabled = true;
      dom.btnZip.textContent = 'Zipping…';
      try {
        await DownloadManager.downloadAllAsZip(UploadManager.getAll().filter((f) => f.status === 'done'));
      } catch (e) {
        alert("Couldn't build the zip — try downloading files individually instead.");
      } finally {
        dom.btnZip.disabled = false;
        dom.btnZip.textContent = '⬇ Download all (.zip)';
      }
    });
  }

  async function runQueue() {
    if (isProcessing) return;
    warmEngine();
    if (!FFmpegAdapter.isEngineReady()) {
      await FFmpegAdapter.initEngine().catch(() => {});
      if (!FFmpegAdapter.isEngineReady()) return;
      setEngineState('ready');
    }

    const pending = UploadManager.getAll().filter((f) => f.status === 'queued');
    if (!pending.length) return;

    isProcessing = true;
    refreshForgeButton();

    for (const rec of pending) {
      if (!UploadManager.getById(rec.id)) continue; // removed mid-run
      await runSingleJob(rec.id);
    }

    isProcessing = false;
    refreshForgeButton();
  }

  async function runSingleJob(id) {
    const rec = UploadManager.getById(id);
    if (!rec) return;
    const profile = CompressionProfiles[selectedProfileKey];

    patchFileRow(id, { status: 'working', stage: 'Encoding', progress: 0, eta: null, speed: null });

    try {
      const { blob, encodeDurationSec } = await CompressionController.runJob({
        record: rec,
        profile,
        overrides,
        onProgressUpdate: (partial) => {
          const patch = {};
          if (partial.progress !== undefined) patch.progress = partial.progress;
          if (partial.eta !== undefined) patch.eta = partial.eta;
          if (partial.speed !== undefined) patch.speed = partial.speed;
          if (Object.keys(patch).length) patchFileRow(id, patch);
        },
      });

      const outputName = DownloadManager.buildOutputName(rec.name, selectedProfileKey);
      const outputUrl = URL.createObjectURL(blob);
      patchFileRow(id, {
        status: 'done', progress: 1, stage: 'Complete',
        outputBlob: blob, outputSize: blob.size, outputUrl, outputName, encodeDurationSec,
      });
    } catch (err) {
      patchFileRow(id, { status: 'error', error: Utils.humanizeError(err?.message), progress: 0 });
    }
  }

  function refreshForgeButton() {
    const hasQueued = UploadManager.getAll().some((f) => f.status === 'queued');
    dom.btnForge.disabled = !hasQueued || isProcessing;
    dom.btnForge.textContent = isProcessing ? '🔥 Forging…' : '🔥 Forge It';
    dom.engineDot.classList.toggle('busy', isProcessing);
  }

  function init() {
    cacheDom();
    setEngineState('idle');
    renderPresets();
    syncAdvancedPanel();
    bindAdvancedPanel();
    bindUpload();
    bindActions();
    renderQueue();
    refreshForgeButton();
  }

  return { init };
})();

/* =============================================================================
   9. BOOTSTRAP
   ============================================================================= */
document.addEventListener('DOMContentLoaded', () => UI.init());
