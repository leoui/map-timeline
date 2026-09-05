/**
 * controls.js
 *
 * Reads form values from the DOM and returns a VideoSettings object.
 * Also manages UI state transitions (idle → loaded → encoding → done).
 */

/** @type {Record<string, { width: number, height: number }>} */
const FORMAT_MAP = {
  sq480:     { width: 480,  height: 480  },
  sq720:     { width: 720,  height: 720  },
  sq1080:    { width: 1080, height: 1080 },
  portrait:  { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

/**
 * Read all form controls and return a VideoSettings object.
 * @returns {import('../types.js').VideoSettings}
 */
export function readSettings() {
  const formatKey = val('format') || 'portrait';
  const { width, height } = FORMAT_MAP[formatKey] ?? FORMAT_MAP.portrait;

  return {
    title:       val('videoTitle') || 'My Google Map Timeline Video',
    durationSec: parseInt(val('duration') || '30', 10),
    fps:         parseInt(val('fps') || '30', 10),
    width,
    height,
    cameraMode:  val('camera') || 'steady',
    distanceUnit: val('unit') || 'km',
    socialPlatform: document.querySelector('input[name="socialPlatform"]:checked')?.value || 'Instagram',
    socialHandle:   (val('socialHandle') || '').trim().replace(/^@+/, ''),
  };
}

/**
 * Read the date range filter from the form.
 * Returns { startMs, endMs } in Unix milliseconds.
 * If "select exact dates" is unchecked, returns full range.
 *
 * Boundaries are returned as "wall-clock" ms (day start/end read as UTC). main.js
 * compares them against each point's wall-clock time (timestamp shifted into the
 * data's own timezone), so a day the user picks means that calendar day in the
 * timezone the data was recorded in, not the viewer's device zone.
 * @returns {{ startMs: number, endMs: number }}
 */
export function readDateRange() {
  const exactDates = document.getElementById('exactDates')?.checked;
  if (!exactDates) return { startMs: -Infinity, endMs: Infinity };

  const startVal = val('startDate');
  const endVal   = val('endDate');

  return {
    startMs: startVal ? Date.parse(`${startVal}T00:00:00.000Z`) : -Infinity,
    endMs:   endVal   ? Date.parse(`${endVal}T23:59:59.999Z`)   : Infinity,
  };
}

/**
 * Read the time-of-day filter, or null if it's off.
 * Returns minutes-of-day for the start and end of the daily window.
 * @returns {{ startMin: number, endMin: number } | null}
 */
export function readTimeOfDay() {
  const on = document.getElementById('exactTimes')?.checked;
  if (!on) return null;
  const toMin = (t) => {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  return { startMin: toMin(val('startTime')), endMin: toMin(val('endTime')) };
}

/**
 * Read the GPS filter mode.
 * @returns {'conservative'|'off'}
 */
export function readFilterMode() {
  return (val('gps') || 'conservative');
}

/**
 * Format a "wall-clock" ms value (timestamp already shifted into the data's own
 * timezone) as YYYY-MM-DD by reading its UTC parts. main.js works in wall time,
 * so the auto-filled range and hint reflect the dates in the DATA's timezone,
 * independent of the viewer's device zone.
 * @param {number} wallMs
 * @returns {string}
 */
function toDateInputValue(wallMs) {
  return new Date(wallMs).toISOString().slice(0, 10);
}

/**
 * Given the full available span of the loaded data, constrain the date inputs
 * to it and default the selection to cover everything. Shows a hint line.
 * @param {number} minMs
 * @param {number} maxMs
 */
export function applyAvailableRange(minMs, maxMs) {
  const startEl = document.getElementById('startDate');
  const endEl   = document.getElementById('endDate');
  const min = toDateInputValue(minMs);
  const max = toDateInputValue(maxMs);

  if (startEl) {
    startEl.min = min; startEl.max = max; startEl.value = min;
  }
  if (endEl) {
    endEl.min = min; endEl.max = max; endEl.value = max;
  }

  const hint = document.getElementById('dateHint');
  if (hint) {
    const fmt = (ms) => new Date(ms).toLocaleDateString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric' });
    hint.textContent = `Data available from ${fmt(minMs)} to ${fmt(maxMs)}.`;
    hint.style.display = 'block';
  }
}

// ── UI state machine ──────────────────────────────────────────────────────────

/** Show the journey configuration UI after a file is loaded. */
export function showJourneyUI() {
  show('statsLine');
  show('privacyBox');
  show('actionRow', 'flex'); // flex column so the button gap/spacing applies
}

/** Switch UI into encoding state - disable controls, show progress. */
export function setEncodingState() {
  show('outputSection');
  setDisabled(['createBtn', 'previewBtn', 'fileInput', 'sampleBtn'], true);
}

/** Switch UI back to idle after encoding finishes or on error. */
export function setIdleState() {
  setDisabled(['createBtn', 'previewBtn', 'fileInput', 'sampleBtn'], false);
}

/** Update the stats line text. */
export function updateStats(pointCount, distanceM, unit) {
  const distStr = unit === 'mi'
    ? `${(distanceM / 1609.34).toFixed(0)} mi`
    : `${(distanceM / 1000).toFixed(0)} km`;

  setText('pointCount', pointCount.toLocaleString());
  setText('distKm', distStr);
}

/** Update the "H.264 supported" banner. */
export function updateCodecBanner(supported) {
  const el = document.getElementById('codecBanner');
  if (!el) return;
  if (supported) {
    el.textContent = 'This browser can create H.264 MP4 video.';
    el.style.color = '';
  } else {
    el.textContent = 'H.264 not supported, will use VP9 (larger files). Chrome 94+ recommended.';
    el.style.color = '#b45309';
  }
}

// ── Tiny DOM helpers ──────────────────────────────────────────────────────────

function val(id) {
  return document.getElementById(id)?.value ?? '';
}

function show(id, display = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = display;
}

function setDisabled(ids, disabled) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
