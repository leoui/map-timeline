/**
 * main.js
 *
 * Top-level orchestrator. Wires the file input → parser → filter →
 * interpolate → prefetch tiles → encode → mux pipeline together.
 *
 * Imported by index.html as a module: <script type="module" src="src/main.js">
 */

import { parseTimeline, summarise } from './parser.js';
import { filterOutliers, totalDistanceMetres } from './journey/filter.js';
import { buildFrames, easeInOut } from './journey/interpolate.js';
import { createCameraState } from './journey/camera.js';
import { prefetchTiles } from './map/tiles.js';
import { fitZoom } from './map/projection.js';
import { createCompositor } from './video/compositor.js';
import { encode, supportsH264 } from './video/encoder.js';
import { muxAndDownload, estimateSizeBytes } from './video/muxer.js';
import { bitrateForFormat } from './video/encoder.js';
import { samplePoints, SAMPLE_META } from './sample-data.js';
import * as progress from './ui/progress.js';
import * as controls from './ui/controls.js';

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {import('./types.js').LocationPoint[] | null} */
let loadedPoints = null;

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  // Codec banner
  const settings = controls.readSettings();
  const h264ok = await supportsH264(settings.width, settings.height);
  controls.updateCodecBanner(h264ok);

  // Wire file input
  document.getElementById('fileInput')?.addEventListener('change', onFileChange);

  // Wire sample button
  document.getElementById('sampleBtn')?.addEventListener('click', onLoadSample);

  // Wire preview button
  document.getElementById('previewBtn')?.addEventListener('click', onPreview);

  // Wire create button
  document.getElementById('createBtn')?.addEventListener('click', onCreateMP4);

  // Wire privacy consent
  document.getElementById('privacyConsent')?.addEventListener('change', () => {
    const btn = document.getElementById('createBtn');
    if (btn) btn.disabled = !document.getElementById('privacyConsent').checked;
  });

  // Wire date toggle
  document.getElementById('exactDates')?.addEventListener('change', () => {
    const dateRow = document.getElementById('dateRow');
    if (dateRow) {
      dateRow.style.display = document.getElementById('exactDates').checked ? 'grid' : 'none';
    }
  });

  // Wire GPS filter hint
  document.getElementById('gps')?.addEventListener('change', updateGpsHint);
})();

// ── File loading ──────────────────────────────────────────────────────────────

async function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const raw  = JSON.parse(text);
    const { startMs, endMs } = controls.readDateRange();
    const parsed = parseTimeline(raw, { startMs, endMs });
    applyLoadedPoints(parsed, file.name);
  } catch (err) {
    showError(err.message);
  }
}

function onLoadSample() {
  const pts = samplePoints();
  applyLoadedPoints(pts, SAMPLE_META.filename);

  const titleEl = document.getElementById('videoTitle');
  if (titleEl) titleEl.value = 'Fictional Sample Journey';
}

function applyLoadedPoints(points, filename) {
  const mode = controls.readFilterMode();
  const filtered = filterOutliers(points, mode);
  loadedPoints = filtered;

  const { count } = summarise(filtered);
  const distM = totalDistanceMetres(filtered);
  const { distanceUnit } = controls.readSettings();

  controls.updateStats(count, distM, distanceUnit);

  const fileInfo = document.getElementById('fileInfo');
  if (fileInfo) {
    fileInfo.style.display = 'block';
    fileInfo.innerHTML = `<strong>${filename}</strong> · ${count.toLocaleString()} valid points`;
  }

  controls.showJourneyUI();
}

// ── Preview ───────────────────────────────────────────────────────────────────

async function onPreview() {
  if (!loadedPoints) return;
  const mapEl = document.getElementById('mapPreview');
  if (!mapEl) return;

  mapEl.style.display = 'block';
  const canvas = document.getElementById('mapCanvas');
  if (!canvas) return;

  const settings = controls.readSettings();
  const size = mapEl.offsetWidth;
  canvas.width = size;
  canvas.height = size;

  // Quick static preview — just show the full journey at zoom-fit
  const { renderMap } = await import('./map/renderer.js');
  const { centroid } = await import('./map/projection.js');
  const zoom = fitZoom(loadedPoints, size, size, 40);
  const { lat, lng } = centroid(loadedPoints);
  await renderMap(canvas, loadedPoints, { centerLat: lat, centerLng: lng, zoom }, 1.0);
}

// ── Encode ────────────────────────────────────────────────────────────────────

async function onCreateMP4() {
  if (!loadedPoints) return;

  progress.reset();

  const labelEl  = document.getElementById('progressLabel');
  const fillEl   = document.getElementById('progressFill');
  const statusEl = document.getElementById('statusEl');
  progress.bindToDOM({ labelEl, fillEl, statusEl });

  controls.setEncodingState();

  try {
    const settings     = controls.readSettings();
    const totalFrames  = settings.fps * settings.durationSec;
    const frames       = easeInOut(buildFrames(loadedPoints, totalFrames));
    const cameraState  = createCameraState(loadedPoints, settings);
    const compositor   = createCompositor(loadedPoints, frames, settings, cameraState);

    // 1. Prefetch tiles
    const prefetchZoom = fitZoom(loadedPoints, settings.width, settings.height, 64);
    progress.emit('tiles:start', { total: 0 }); // total computed inside prefetch
    await prefetchTiles(
      loadedPoints,
      prefetchZoom,
      (loaded, total) => progress.emit('tiles:progress', { loaded, total })
    );
    progress.emit('tiles:done');

    // 2. Encode
    progress.emit('encode:start', { total: totalFrames });
    const result = await encode(compositor, frames, settings, (encoded, total) => {
      progress.emit('encode:progress', { encoded, total });
    });
    progress.emit('encode:done');

    // 3. Mux + download
    progress.emit('mux:start');
    const buffer = await muxAndDownload(result, settings);
    progress.emit('mux:done', { sizeBytes: buffer.byteLength });

    showDownloadButton(settings);

  } catch (err) {
    progress.emit('error', { message: err.message });
    console.error(err);
  } finally {
    controls.setIdleState();
  }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function updateGpsHint() {
  const hint = document.getElementById('gpsHint');
  if (!hint) return;
  const mode = document.getElementById('gps')?.value;
  hint.textContent = mode === 'off'
    ? 'No filtering applied. All location points will be included as-is.'
    : 'Conservative filtering ignores only short, impossible round trips. Your Timeline file is never changed.';
}

function showError(message) {
  const el = document.getElementById('errorBanner');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  } else {
    alert(message);
  }
}

function showDownloadButton(settings) {
  const row = document.getElementById('actionRow');
  if (!row || document.getElementById('dlBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'dlBtn';
  btn.className = 'btn btn-primary';
  btn.style.gridColumn = 'span 2';
  btn.textContent = 'Download MP4';
  btn.onclick = () => onCreateMP4(); // re-encode on second click
  row.appendChild(btn);
}
