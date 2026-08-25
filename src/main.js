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
import { createCameraState, representativeZoom } from './journey/camera.js';
import { prefetchAlongPath } from './map/tiles.js';
import { fitZoom } from './map/projection.js';
import { createCompositor } from './video/compositor.js';
import { encode, supportsH264 } from './video/encoder.js';
import { muxToBuffer, saveVideo, estimateSizeBytes } from './video/muxer.js';
import { bitrateForFormat } from './video/encoder.js';
import { samplePoints, SAMPLE_META } from './sample-data.js';
import * as progress from './ui/progress.js';
import * as controls from './ui/controls.js';

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {import('./types.js').LocationPoint[] | null} */
let loadedPoints = null;

/**
 * All parsed points for the current file, across the full available span,
 * before any date-range or GPS filtering. Date/GPS selection is derived from
 * this so the user can re-slice without re-uploading.
 * @type {import('./types.js').LocationPoint[] | null}
 */
let allRawPoints = null;

/** Filename of the currently loaded data, for the file-info line. */
let loadedFilename = '';

/**
 * The most recently encoded video, kept so the Download button can save it
 * without re-encoding (and so the save dialog opens from that click's gesture).
 * @type {{ buffer: ArrayBuffer, settings: import('./types.js').VideoSettings } | null}
 */
let lastVideo = null;

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
    recomputeSelection();
  });

  // Re-slice the loaded data whenever the date range changes.
  document.getElementById('startDate')?.addEventListener('change', recomputeSelection);
  document.getElementById('endDate')?.addEventListener('change', recomputeSelection);

  // Wire GPS filter hint + re-filter
  document.getElementById('gps')?.addEventListener('change', () => {
    updateGpsHint();
    recomputeSelection();
  });
})();

// ── File loading ──────────────────────────────────────────────────────────────

async function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const raw  = JSON.parse(text);
    // Parse the FULL span (no date filter) so we can show what's available and
    // let the user re-slice without re-uploading.
    const parsed = parseTimeline(raw);
    setLoadedData(parsed, file.name);
  } catch (err) {
    showError(err.message);
  }
}

function onLoadSample() {
  const pts = samplePoints();
  setLoadedData(pts, SAMPLE_META.filename);

  const titleEl = document.getElementById('videoTitle');
  if (titleEl) titleEl.value = 'Fictional Sample Journey';
}

/**
 * Store a freshly parsed, unfiltered dataset, surface its available date span,
 * and derive the initial selection.
 * @param {import('./types.js').LocationPoint[]} points
 * @param {string} filename
 */
function setLoadedData(points, filename) {
  allRawPoints = points;
  loadedFilename = filename;

  // Points come back sorted from parseTimeline; guard anyway.
  const minMs = points[0].timestampMs;
  const maxMs = points[points.length - 1].timestampMs;
  controls.applyAvailableRange(minMs, maxMs);

  controls.showJourneyUI();
  recomputeSelection();
}

/**
 * Recompute loadedPoints from allRawPoints using the current date-range and
 * GPS filter settings, and refresh the stats / file-info display.
 */
function recomputeSelection() {
  if (!allRawPoints) return;

  const { startMs, endMs } = controls.readDateRange();
  const inRange = allRawPoints.filter(
    (p) => p.timestampMs >= startMs && p.timestampMs <= endMs
  );

  const mode = controls.readFilterMode();
  const filtered = filterOutliers(inRange, mode);
  loadedPoints = filtered;

  const { count } = summarise(filtered);
  const distM = totalDistanceMetres(filtered);
  const { distanceUnit } = controls.readSettings();
  controls.updateStats(count, distM, distanceUnit);

  const fileInfo = document.getElementById('fileInfo');
  if (fileInfo) {
    fileInfo.style.display = 'block';
    if (count < 2) {
      fileInfo.innerHTML =
        `<strong>${loadedFilename}</strong> · ${count.toLocaleString()} points in this date range ` +
        `— widen the range to build a video.`;
    } else {
      fileInfo.innerHTML =
        `<strong>${loadedFilename}</strong> · ${count.toLocaleString()} valid points`;
    }
  }
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

    // 1. Prefetch tiles along the path at the zoom the camera will render at,
    //    so the encode loop reads from cache instead of stalling on the network.
    const prefetchZoom = representativeZoom(cameraState, settings);
    progress.emit('tiles:start', { total: 0 }); // total computed inside prefetch
    await prefetchAlongPath(
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

    // 3. Mux into an MP4 buffer (saving happens on the Download click so the
    //    OS "save as" dialog can open from a real user gesture).
    progress.emit('mux:start');
    const buffer = await muxToBuffer(result, settings);
    lastVideo = { buffer, settings };
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
  btn.onclick = onDownload; // save the already-encoded video (opens save dialog)
  row.appendChild(btn);
}

async function onDownload() {
  if (!lastVideo) return;
  try {
    const outcome = await saveVideo(lastVideo.buffer, lastVideo.settings);
    if (outcome === 'cancelled') return; // user closed the save dialog — no-op
  } catch (err) {
    showError(`Could not save the video: ${err.message}`);
  }
}
