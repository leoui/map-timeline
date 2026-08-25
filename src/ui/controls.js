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
  };
}

/**
 * Read the date range filter from the form.
 * Returns { startMs, endMs } in Unix milliseconds.
 * If "select exact dates" is unchecked, returns full range.
 * @returns {{ startMs: number, endMs: number }}
 */
export function readDateRange() {
  const exactDates = document.getElementById('exactDates')?.checked;
  if (!exactDates) return { startMs: -Infinity, endMs: Infinity };

  const startVal = val('startDate');
  const endVal   = val('endDate');

  const startMs = startVal ? Date.parse(startVal) : -Infinity;
  const endMs   = endVal   ? Date.parse(endVal) + 86_400_000 - 1 : Infinity; // end of day

  return { startMs, endMs };
}

/**
 * Read the GPS filter mode.
 * @returns {'conservative'|'off'}
 */
export function readFilterMode() {
  return (val('gps') || 'conservative');
}

/**
 * Format a Unix-ms timestamp as a YYYY-MM-DD string (UTC) for <input type=date>.
 * UTC matches how readDateRange() interprets the inputs (Date.parse of a bare
 * date is UTC midnight), so the round-trip stays consistent.
 * @param {number} ms
 * @returns {string}
 */
function toDateInputValue(ms) {
  return new Date(ms).toISOString().slice(0, 10);
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

/** Switch UI into encoding state — disable controls, show progress. */
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
