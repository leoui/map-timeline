/**
 * main.js
 *
 * Top-level orchestrator. Wires the file input → parser → filter →
 * interpolate → prefetch tiles → encode → mux pipeline together.
 *
 * Imported by index.html as a module: <script type="module" src="src/main.js">
 */

import { parseTimeline, summarise, detectTimezoneOffsetMin, majorityOffsetMin, distinctOffsets } from './parser.js';
import { parseTrackFile } from './track-parser.js';
import { stravaConnect, initStrava } from './strava.js';
import { filterOutliers, totalDistanceMetres } from './journey/filter.js';
import { buildFrames, easeInOut } from './journey/interpolate.js';
import { createCameraState, representativeZoom } from './journey/camera.js';
import { prefetchAlongPath, setTileProvider, CURRENT_ATTRIBUTION } from './map/tiles.js';
import { fitZoom, fitZoomFractional } from './map/projection.js';
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
 * Timezone offset (minutes east of UTC) the data was recorded in. Date and
 * time-of-day filtering happen in this "wall clock", read from the data itself
 * (the JSON's ISO offsets or a Strava activity's local time), so filtering is
 * independent of the viewer's device timezone. Falls back to the viewer's zone
 * only when the data carries no timezone (e.g. epoch-only or GPX in UTC).
 */
let tzOffsetMin = -new Date().getTimezoneOffset();

/**
 * The "home" offset for the loaded data: the zone most of it was recorded in.
 * When a journey crosses zones, the user can override the active offset with the
 * timezone picker; `tzMode` says how the active `tzOffsetMin` is derived:
 *   'home'  - always the home zone (default; one unified timeline)
 *   'range' - the majority zone among the points in the selected date range
 *   'fixed' - a specific zone the user picked (`tzFixedOffset`)
 */
let tzHomeOffset = -new Date().getTimezoneOffset();
let tzMode = 'home';
/** @type {number|null} */
let tzFixedOffset = null;

/** Viewer's own UTC offset in minutes, used as a fallback. */
function viewerOffsetMin() { return -new Date().getTimezoneOffset(); }

/** A point's wall-clock time (ms) in the active timezone, treated as UTC. */
function wallOf(p) { return p.timestampMs + tzOffsetMin * 60_000; }

/** "GMT+09:00" style label for an offset in minutes east of UTC. */
function gmtLabel(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `GMT${sign}${hh}:${mm}`;
}

/**
 * Fill the timezone picker from the zones actually present in the data, and show
 * it only when the journey genuinely spans more than one zone. Resets to the
 * home zone on every fresh load.
 * @param {import('./types.js').LocationPoint[]} points
 */
function populateTimezonePicker(points) {
  const row = document.getElementById('tzRow');
  const sel = document.getElementById('tzSelect');
  tzMode = 'home';
  tzFixedOffset = null;
  if (!row || !sel) return;

  const offs = distinctOffsets(points);
  if (offs.length < 2) { row.style.display = 'none'; return; } // single zone: nothing to choose

  const t = (k, fb) => (window.i18nText && window.i18nText(k)) || fb;
  const opts = [
    `<option value="home">${t('tz.home', 'Home zone (most of your data)')} (${gmtLabel(tzHomeOffset)})</option>`,
    `<option value="range">${t('tz.range', 'Match the selected date range')}</option>`,
  ];
  for (const o of offs) opts.push(`<option value="fix:${o.offsetMin}">${gmtLabel(o.offsetMin)}</option>`);
  sel.innerHTML = opts.join('');
  sel.value = 'home';
  row.style.display = 'block';
}

/**
 * The most recently encoded video, kept so the Download button can save it
 * without re-encoding (and so the save dialog opens from that click's gesture).
 * Stored as an immutable Blob so it can't be detached before the user saves.
 * @type {{ blob: Blob, settings: import('./types.js').VideoSettings } | null}
 */
let lastVideo = null;

/** Guard against overlapping save dialogs (e.g. a double-click on Download). */
let saving = false;

/**
 * The Strava activity behind the current data, if it came from Strava, so the
 * video overlay can show its stats (Time, Pace, Elevation). Null for uploads.
 * @type {any|null}
 */
let stravaActivity = null;

/** Uploaded background photo (ImageBitmap) for photo-overlay mode. */
let overlayImage = null;

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
  document.getElementById('privacyConsent')?.addEventListener('change', refreshActionsEnabled);

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

  // Timezone picker for cross-zone journeys.
  document.getElementById('tzSelect')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'range') { tzMode = 'range'; tzFixedOffset = null; }
    else if (v.startsWith('fix:')) { tzMode = 'fixed'; tzFixedOffset = parseInt(v.slice(4), 10); }
    else { tzMode = 'home'; tzFixedOffset = null; }
    recomputeSelection();
    if (previewOpen()) onPreview();
  });

  // Time-of-day filter toggle + inputs.
  document.getElementById('exactTimes')?.addEventListener('change', () => {
    const row = document.getElementById('timeRow');
    if (row) row.style.display = document.getElementById('exactTimes').checked ? 'grid' : 'none';
    recomputeSelection();
  });
  document.getElementById('startTime')?.addEventListener('change', recomputeSelection);
  document.getElementById('endTime')?.addEventListener('change', recomputeSelection);

  // Wire GPS filter hint + re-filter
  document.getElementById('gps')?.addEventListener('change', () => {
    updateGpsHint();
    recomputeSelection();
  });

  // Wire map style: switch tile provider and refresh the preview if it's open.
  applyMapStyle();
  document.getElementById('mapStyle')?.addEventListener('change', () => {
    applyMapStyle();
    if (previewOpen()) onPreview();
  });

  // Wire background mode (map vs photo overlay).
  updatePhotoUI();
  document.getElementById('backgroundMode')?.addEventListener('change', () => {
    updatePhotoUI();
    if (previewOpen()) onPreview();
  });
  document.getElementById('photoBtn')?.addEventListener('click', () => document.getElementById('photoInput')?.click());
  document.getElementById('photoInput')?.addEventListener('change', onPhotoChange);
  document.getElementById('overlayStyle')?.addEventListener('change', () => { if (previewOpen()) onPreview(); });

  // Strava connect + handle the OAuth redirect back.
  document.getElementById('stravaBtn')?.addEventListener('click', stravaConnect);
  initStrava({
    onActivity: ({ points, title, activity }) => {
      // Filter in the activity's own local timezone (from Strava's start_date_local).
      const off = stravaOffsetMin(activity);
      tzHomeOffset = off != null ? off : viewerOffsetMin();
      setLoadedData(points, `${title} (Strava)`);
      stravaActivity = activity || null; // set after load (setLoadedData path clears it)
      const t = document.getElementById('videoTitle');
      if (t) t.value = title;
    },
    onError: showError,
    onBusy: setStravaBusy,
  });
})();

/**
 * Derive an activity's UTC offset (minutes) from Strava's start_date (UTC) and
 * start_date_local (same instant expressed in the athlete's local time, but
 * suffixed 'Z'). Returns null if either is missing.
 */
function stravaOffsetMin(activity) {
  if (!activity || !activity.start_date || !activity.start_date_local) return null;
  const utc = Date.parse(activity.start_date);
  const local = Date.parse(activity.start_date_local);
  if (!Number.isFinite(utc) || !Number.isFinite(local)) return null;
  return Math.round((local - utc) / 60000);
}

/** Reflect the Strava connection state on the button. */
function setStravaBusy(busy) {
  const btn = document.getElementById('stravaBtn');
  if (!btn) return;
  btn.disabled = busy;
  const span = btn.querySelector('span');
  if (span) {
    const key = busy ? 'strava.connecting' : 'strava.connect';
    span.textContent = (window.i18nText && window.i18nText(key)) || (busy ? 'Connecting to Strava…' : 'Connect with Strava');
  }
}

/** Read the chosen map style and switch the global tile provider to it. */
function applyMapStyle() {
  const style = document.getElementById('mapStyle')?.value || 'carto_light';
  try { setTileProvider(style); } catch { /* ignore unknown style */ }
}

function previewOpen() {
  const m = document.getElementById('mapPreview');
  return !!m && m.style.display !== 'none';
}

/** Show/hide the photo controls and force a 9:16 format when photo mode is on. */
function updatePhotoUI() {
  const photo = document.getElementById('backgroundMode')?.value === 'photo';
  const row = document.getElementById('photoRow');
  if (row) row.style.display = photo ? 'block' : 'none';
  const fmt = document.getElementById('format');
  if (fmt) {
    if (photo) { fmt.value = 'portrait'; fmt.disabled = true; }
    else { fmt.disabled = false; }
  }
}

async function onPhotoChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    overlayImage = await createImageBitmap(file);
    const info = document.getElementById('photoInfo');
    if (info) info.textContent = `${file.name} · ${overlayImage.width}×${overlayImage.height}`;
    if (previewOpen()) onPreview();
  } catch {
    showError('Could not read that image. Please try a different photo.');
  }
}

/** Build the photo-overlay portion of the encode metadata. */
function backgroundMeta() {
  const mode = document.getElementById('backgroundMode')?.value || 'map';
  const style = document.getElementById('overlayStyle')?.value || 'line';
  const usingPhoto = mode === 'photo' && !!overlayImage;
  return {
    backgroundMode: mode,
    overlayStyle: style,
    backgroundImage: usingPhoto ? overlayImage : null,
    // No map tiles are drawn for the route-line style, so no attribution needed.
    showAttribution: !(usingPhoto && style === 'line'),
  };
}

// ── File loading ──────────────────────────────────────────────────────────────

async function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    // GPX / TCX run files (Strava, Garmin, Apple Health exports) or Timeline JSON.
    // Parse the FULL span (no date filter) so we can show what's available and
    // let the user re-slice without re-uploading.
    const track = parseTrackFile(text, file.name);
    let parsed;
    if (track) {
      parsed = track;
      tzHomeOffset = viewerOffsetMin(); // GPX/TCX times are UTC; no local zone to read
    } else {
      const raw = JSON.parse(text);
      parsed = parseTimeline(raw);
      // Home zone = the offset most of the data was recorded in (per-point),
      // falling back to a raw scan then the device zone.
      const detected = majorityOffsetMin(parsed) ?? detectTimezoneOffsetMin(raw);
      tzHomeOffset = detected != null ? detected : viewerOffsetMin();
    }
    setLoadedData(parsed, file.name);
  } catch (err) {
    showError(err.message);
  }
}

function onLoadSample() {
  const pts = samplePoints();
  tzHomeOffset = viewerOffsetMin(); // sample data has no real timezone
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
  stravaActivity = null; // uploads/samples have no Strava stats (re-set by the Strava path)

  // Start in the home zone; offer the picker only when the data crosses zones.
  tzOffsetMin = tzHomeOffset;
  populateTimezonePicker(points);

  // Available range in the data's own timezone (wall clock), so the date fields
  // and hint show the days as recorded, not shifted by the viewer's zone.
  const minMs = wallOf(points[0]);
  const maxMs = wallOf(points[points.length - 1]);
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

  // Resolve the active display offset from the chosen timezone mode. For 'range',
  // decide membership with the home zone first, then adopt the majority zone of
  // those points so a trip abroad is shown in its own local time.
  if (tzMode === 'fixed' && tzFixedOffset != null) {
    tzOffsetMin = tzFixedOffset;
  } else if (tzMode === 'range') {
    tzOffsetMin = tzHomeOffset;
    const r = controls.readDateRange();
    const cand = allRawPoints.filter((p) => { const w = wallOf(p); return w >= r.startMs && w <= r.endMs; });
    tzOffsetMin = majorityOffsetMin(cand) ?? tzHomeOffset;
  } else {
    tzOffsetMin = tzHomeOffset;
  }

  // Date range + time-of-day are both evaluated in the data's own timezone
  // (wall clock), read from the file, not the viewer's device zone.
  const { startMs, endMs } = controls.readDateRange();
  let inRange = allRawPoints.filter((p) => {
    const w = wallOf(p);
    return w >= startMs && w <= endMs;
  });

  // Optional time-of-day window (e.g. a 5 AM - 7 AM morning run). Uses the data's
  // local wall clock; wraps past midnight when start > end.
  const tod = controls.readTimeOfDay();
  if (tod) {
    inRange = inRange.filter((p) => {
      const d = new Date(wallOf(p));
      const min = d.getUTCHours() * 60 + d.getUTCMinutes();
      return tod.startMin <= tod.endMin
        ? (min >= tod.startMin && min <= tod.endMin)
        : (min >= tod.startMin || min <= tod.endMin);
    });
  }

  const mode = controls.readFilterMode();
  const filtered = filterOutliers(inRange, mode);
  loadedPoints = filtered;

  const { count } = summarise(filtered);
  const distM = totalDistanceMetres(filtered);
  const { distanceUnit } = controls.readSettings();
  controls.updateStats(count, distM, distanceUnit);
  refreshActionsEnabled();

  // Surprise: how many times has this journey circled the Earth?
  // Earth's circumference is 40075 km; show the banner only at 1+ full laps.
  const EARTH_CIRCUMFERENCE_M = 40075 * 1000;
  const laps = Math.floor(distM / EARTH_CIRCUMFERENCE_M);
  const brag = document.getElementById('earthBrag');
  if (brag) {
    brag.setAttribute('data-laps', String(laps));
    if (window.renderEarthBrag) window.renderEarthBrag();
    else brag.style.display = laps >= 1 ? 'block' : 'none';
  }

  const fileInfo = document.getElementById('fileInfo');
  if (fileInfo) {
    fileInfo.style.display = 'block';
    if (count < 2) {
      fileInfo.innerHTML =
        `<strong>${loadedFilename}</strong> · ${count.toLocaleString()} points in this date range. ` +
        `Widen the range to build a video.`;
    } else {
      fileInfo.innerHTML =
        `<strong>${loadedFilename}</strong> · ${count.toLocaleString()} valid points`;
    }
  }
}

/**
 * Format the selected journey's date span as "Mon D, YYYY - Mon D, YYYY"
 * (or a single date if the span is one day). Uses a hyphen, no dashes.
 * @param {import('./types.js').LocationPoint[]} pts
 * @returns {string}
 */
function dateRangeLabel(pts) {
  if (!pts || pts.length === 0) return '';
  // Format in the data's timezone (wall clock read as UTC) so the card shows the
  // dates as they were where the trip happened.
  const fmt = (ms) => new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const start = fmt(wallOf(pts[0]));
  const end = fmt(wallOf(pts[pts.length - 1]));
  return start === end ? start : `${start} - ${end}`;
}

/**
 * Build the Strava-style overlay stats for an activity, mirroring the Strava
 * share cards: Distance (animated), Time, Pace, and Elevation gain when notable.
 * Returns null for non-Strava data so the normal date/distance card is used.
 * @param {any|null} a  Strava activity summary
 * @param {string} unit 'km' | 'mi' | 'auto'
 * @returns {Array<{label:string,value?:string,key?:string}>|null}
 */
function stravaStats(a, unit) {
  if (!a) return null;
  const T = (k, fallback) => (window.i18nText && window.i18nText(k)) || fallback;
  const stats = [
    { key: 'distance', label: T('sv.distance', 'Distance') }, // animates 0 -> total
    { label: T('sv.time', 'Time'), value: formatDuration(a.moving_time || a.elapsed_time) },
    { label: T('sv.pace', 'Pace'), value: formatPace(a.average_speed, unit) },
  ];
  if (a.total_elevation_gain && a.total_elevation_gain >= 20) {
    stats.push({ label: T('sv.elev', 'Elev Gain'), value: formatElevation(a.total_elevation_gain, unit) });
  }
  return stats;
}

/** Seconds -> "1h 5m" or "34m 5s". */
function formatDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

/** Average speed (m/s) -> "6:17 /km" (or /mi). */
function formatPace(avgSpeed, unit) {
  if (!avgSpeed || avgSpeed <= 0) return '--';
  const perUnit = (unit === 'mi' ? 1609.34 : 1000) / avgSpeed; // seconds per km/mi
  const mm = Math.floor(perUnit / 60);
  const ss = Math.round(perUnit % 60);
  return `${mm}:${String(ss).padStart(2, '0')} /${unit === 'mi' ? 'mi' : 'km'}`;
}

/** Metres -> "120 m" or "394 ft". */
function formatElevation(m, unit) {
  return unit === 'mi'
    ? `${Math.round(m * 3.28084).toLocaleString()} ft`
    : `${Math.round(m).toLocaleString()} m`;
}

/**
 * Enable Preview/Create only when there are at least 2 points to render (and,
 * for Create, the privacy consent is checked). Prevents the "zero frames" case.
 */
function refreshActionsEnabled() {
  const n = loadedPoints ? loadedPoints.length : 0;
  const consent = document.getElementById('privacyConsent')?.checked;
  const previewBtn = document.getElementById('previewBtn');
  const createBtn = document.getElementById('createBtn');
  if (previewBtn) previewBtn.disabled = n < 2;
  if (createBtn) createBtn.disabled = n < 2 || !consent;
}

// ── Preview ───────────────────────────────────────────────────────────────────

async function onPreview() {
  if (!loadedPoints || loadedPoints.length < 2) {
    showError((window.i18nText && window.i18nText('err.nopoints')) ||
      'No points to render. Widen the date or time-of-day range, or pick another activity.');
    return;
  }
  const mapEl = document.getElementById('mapPreview');
  if (!mapEl) return;

  mapEl.style.display = 'block';
  const canvas = document.getElementById('mapCanvas');
  if (!canvas) return;

  applyMapStyle();
  const settings = controls.readSettings();
  const bg = backgroundMeta();

  // ── Photo-overlay preview: composite a representative (final) frame ──────
  if (bg.backgroundMode === 'photo' && overlayImage) {
    mapEl.style.aspectRatio = '9 / 16';
    const width = 1080, height = 1920;
    const previewSettings = { ...settings, width, height };
    const totalFrames = 60;
    const frames = easeInOut ? buildFrames(loadedPoints, totalFrames, easeInOut) : buildFrames(loadedPoints, totalFrames);
    const cameraState = createCameraState(loadedPoints, previewSettings);
    const meta = {
      dateLabel: dateRangeLabel(loadedPoints),
      totalMeters: totalDistanceMetres(loadedPoints),
      distanceUnit: settings.distanceUnit,
      attribution: CURRENT_ATTRIBUTION,
      stats: stravaStats(stravaActivity, settings.distanceUnit),
      ...bg,
    };
    const comp = createCompositor(loadedPoints, frames, previewSettings, cameraState, meta);
    await comp.drawFrame(frames.length - 1); // final frame = whole route drawn
    canvas.width = width;
    canvas.height = height;
    const bmp = await createImageBitmap(comp.canvas);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return;
  }

  // ── Map preview: full journey at zoom-fit (square) ──────────────────────
  mapEl.style.aspectRatio = '1 / 1';
  const size = mapEl.offsetWidth;
  canvas.width = size;
  canvas.height = size;
  const { renderMap } = await import('./map/renderer.js');
  const { centroid } = await import('./map/projection.js');
  const zoom = fitZoomFractional(loadedPoints, size, size, size * 0.08);
  const { lat, lng } = centroid(loadedPoints);
  await renderMap(canvas, loadedPoints, { centerLat: lat, centerLng: lng, zoom }, {});
}

// ── Encode ────────────────────────────────────────────────────────────────────

async function onCreateMP4() {
  // An empty array is truthy, so check the length: a date / time-of-day filter
  // can leave nothing to render, which would otherwise fail deep in the encoder.
  if (!loadedPoints || loadedPoints.length < 2) {
    showError((window.i18nText && window.i18nText('err.nopoints')) ||
      'No points to render. Widen the date or time-of-day range, or pick another activity.');
    return;
  }

  progress.reset();

  const labelEl  = document.getElementById('progressLabel');
  const fillEl   = document.getElementById('progressFill');
  const statusEl = document.getElementById('statusEl');
  progress.bindToDOM({ labelEl, fillEl, statusEl });

  controls.setEncodingState();

  try {
    const settings     = controls.readSettings();
    const bg           = backgroundMeta();

    // Photo overlay needs an uploaded image and a 9:16 canvas.
    if (bg.backgroundMode === 'photo' && !overlayImage) {
      throw new Error('Please choose a 9:16 photo first, or switch the background back to Map.');
    }
    if (bg.backgroundMode === 'photo') { settings.width = 1080; settings.height = 1920; }

    const totalFrames  = settings.fps * settings.durationSec;
    const frames       = buildFrames(loadedPoints, totalFrames, easeInOut);
    const cameraState  = createCameraState(loadedPoints, settings);

    applyMapStyle(); // make sure the encoder uses the selected tile provider

    // Overlay metadata for the title card: date range of the selection and the
    // total distance (which the card animates 0 -> total along the line).
    const meta = {
      dateLabel: dateRangeLabel(loadedPoints),
      totalMeters: totalDistanceMetres(loadedPoints),
      distanceUnit: settings.distanceUnit,
      attribution: CURRENT_ATTRIBUTION,
      stats: stravaStats(stravaActivity, settings.distanceUnit),
      ...bg,
    };
    const compositor   = createCompositor(loadedPoints, frames, settings, cameraState, meta);

    // 1. Prefetch tiles along the path at the zoom the camera will render at,
    //    so the encode loop reads from cache instead of stalling on the network.
    const prefetchZoom = Math.round(representativeZoom(cameraState, settings));
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
    const blob = new Blob([buffer], { type: 'video/mp4' });
    lastVideo = { blob, settings };
    progress.emit('mux:done', { sizeBytes: blob.size });

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
  btn.setAttribute('data-i18n', 'btn.download'); // so the language toggle updates it
  btn.textContent = (window.i18nText && window.i18nText('btn.download')) || 'Download MP4';
  btn.onclick = onDownload; // save the already-encoded video (opens save dialog)
  row.appendChild(btn);
}

async function onDownload() {
  if (!lastVideo || saving) return; // ignore re-entrant clicks - one dialog at a time
  saving = true;
  const btn = document.getElementById('dlBtn');
  if (btn) btn.disabled = true;
  try {
    const outcome = await saveVideo(lastVideo.blob, lastVideo.settings);
    if (outcome === 'cancelled') return; // user closed the save dialog - no-op
  } catch (err) {
    showError(`Could not save the video: ${err.message}`);
  } finally {
    saving = false;
    if (btn) btn.disabled = false;
  }
}
