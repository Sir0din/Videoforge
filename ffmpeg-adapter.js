// =============================================================================
// FFMPEG ADAPTER
// -----------------------------------------------------------------------------
// This is the ONLY module in Video Forge allowed to import or call the
// official @ffmpeg/ffmpeg package directly. Every other module (Compression
// Controller, Media Analyzer, UI Layer, etc.) must go through the functions
// exported here — none of them may reference `FFmpeg`, `fetchFile`, or
// `toBlobURL` themselves.
//
// Integration follows the official ffmpeg.wasm browser usage pattern exactly:
// https://ffmpegwasm.netlify.app/docs/getting-started/usage
//   1. import { FFmpeg } from '@ffmpeg/ffmpeg'
//   2. import { fetchFile, toBlobURL } from '@ffmpeg/util'
//   3. new FFmpeg() -> ffmpeg.on('log'/'progress') -> ffmpeg.load({ coreURL, wasmURL })
//   4. ffmpeg.writeFile / ffmpeg.exec / ffmpeg.readFile / ffmpeg.deleteFile
//
// We load the single-threaded core (@ffmpeg/core, not core-mt) deliberately:
// the multi-threaded core requires SharedArrayBuffer, which needs
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy response headers
// that a static GitHub Pages deployment does not send by default. The
// single-threaded core works with zero server configuration, which matches
// this project's "must run on GitHub Pages" constraint. This is a real
// engineering tradeoff, not a placeholder: it costs some encode speed in
// exchange for guaranteed compatibility.
// =============================================================================

const FFMPEG_PKG = '@ffmpeg' + '/ffmpeg' + '@0.12.10';
const UTIL_PKG = '@ffmpeg' + '/util' + '@0.12.1';
const CORE_PKG = '@ffmpeg' + '/core' + '@0.12.6';

const { FFmpeg } = await import(`https://cdn.jsdelivr.net/npm/${FFMPEG_PKG}/dist/esm/index.js`);
const { fetchFile, toBlobURL } = await import(`https://cdn.jsdelivr.net/npm/${UTIL_PKG}/dist/esm/index.js`);

const CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/${CORE_PKG}/dist/esm`;

let ffmpegInstance = null;
let engineReady = false;
let loadPromise = null;

const logSubscribers = new Set();
const progressSubscribers = new Set();

/**
 * Lazily creates and loads the FFmpeg engine. Safe to call multiple times —
 * concurrent callers share the same in-flight load. Nothing is fetched or
 * instantiated until this is called (satisfies the "lazy-load FFmpeg only
 * after a file is selected" requirement).
 */
export function initEngine() {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ffmpegInstance = new FFmpeg();

    ffmpegInstance.on('log', ({ message }) => {
      logSubscribers.forEach((fn) => fn(message));
    });

    ffmpegInstance.on('progress', ({ progress, time }) => {
      progressSubscribers.forEach((fn) => fn({ progress, time }));
    });

    await ffmpegInstance.load({
      coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    engineReady = true;
  })();

  return loadPromise;
}

export function isEngineReady() {
  return engineReady;
}

/** Subscribe to raw FFmpeg log lines. Returns an unsubscribe function. */
export function onLog(callback) {
  logSubscribers.add(callback);
  return () => logSubscribers.delete(callback);
}

/** Subscribe to FFmpeg progress events ({ progress: 0..1, time }). Returns an unsubscribe function. */
export function onProgress(callback) {
  progressSubscribers.add(callback);
  return () => progressSubscribers.delete(callback);
}

/** Writes a browser File/Blob into the FFmpeg virtual filesystem. */
export async function writeInputFile(virtualName, file) {
  const data = await fetchFile(file);
  await ffmpegInstance.writeFile(virtualName, data);
}

/** Executes an arbitrary FFmpeg command. Args mirror the FFmpeg CLI, minus the leading "ffmpeg". */
export async function execute(args) {
  return ffmpegInstance.exec(args);
}

/** Reads a file back out of the FFmpeg virtual filesystem. */
export async function readOutputFile(virtualName) {
  return ffmpegInstance.readFile(virtualName);
}

/** Deletes one or more files from the FFmpeg virtual filesystem to free memory. Ignores missing files. */
export async function cleanupFiles(virtualNames) {
  for (const name of virtualNames) {
    try {
      await ffmpegInstance.deleteFile(name);
    } catch (e) {
      // File already gone or never written — nothing to clean up.
    }
  }
}
