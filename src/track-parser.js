/**
 * track-parser.js
 *
 * Parses GPS track files (GPX and TCX) exported from Strava, Garmin, Apple
 * Health, and most run trackers into the same LocationPoint[] the rest of the
 * app uses. Runs in the browser (uses DOMParser); all local, nothing uploaded.
 */

/**
 * Parse a GPX document into LocationPoint[].
 * @param {string} text
 * @returns {import('./types.js').LocationPoint[]}
 */
export function parseGpx(text) {
  const doc = parseXml(text, 'GPX');
  const out = [];
  // Track points first; fall back to route points / waypoints if that's all there is.
  const nodes = doc.querySelectorAll('trkpt, rtept, wpt');
  nodes.forEach((el) => {
    const lat = parseFloat(el.getAttribute('lat'));
    const lng = parseFloat(el.getAttribute('lon'));
    const timeEl = el.querySelector('time');
    const ts = timeEl ? Date.parse(timeEl.textContent.trim()) : NaN;
    if (isValidCoord(lat, lng)) out.push({ lat, lng, timestampMs: ts });
  });
  return finalize(out, 'GPX');
}

/**
 * Parse a TCX document into LocationPoint[].
 * @param {string} text
 * @returns {import('./types.js').LocationPoint[]}
 */
export function parseTcx(text) {
  const doc = parseXml(text, 'TCX');
  const out = [];
  doc.querySelectorAll('Trackpoint').forEach((tp) => {
    const lat = parseFloat(tp.querySelector('Position > LatitudeDegrees')?.textContent);
    const lng = parseFloat(tp.querySelector('Position > LongitudeDegrees')?.textContent);
    const t = tp.querySelector('Time')?.textContent;
    const ts = t ? Date.parse(t.trim()) : NaN;
    if (isValidCoord(lat, lng)) out.push({ lat, lng, timestampMs: ts });
  });
  return finalize(out, 'TCX');
}

/**
 * Detect and parse a track file by extension/content. Returns null if the text
 * doesn't look like GPX or TCX (so the caller can fall back to JSON).
 * @param {string} text
 * @param {string} filename
 * @returns {import('./types.js').LocationPoint[] | null}
 */
export function parseTrackFile(text, filename = '') {
  const name = filename.toLowerCase();
  if (name.endsWith('.gpx') || /<gpx[\s>]/i.test(text)) return parseGpx(text);
  if (name.endsWith('.tcx') || /<TrainingCenterDatabase[\s>]/i.test(text)) return parseTcx(text);
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseXml(text, kind) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(`This ${kind} file could not be read. It may be corrupted.`);
  }
  return doc;
}

function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * Fill in any missing timestamps (some GPX files omit <time>) with a steady
 * 1-second cadence so interpolation and filtering still work, then sort.
 */
function finalize(points, kind) {
  if (points.length === 0) {
    throw new Error(`No GPS points found in this ${kind} file.`);
  }
  const base = Date.now() - points.length * 1000;
  points.forEach((p, i) => {
    if (!Number.isFinite(p.timestampMs)) p.timestampMs = base + i * 1000;
  });
  points.sort((a, b) => a.timestampMs - b.timestampMs);
  return points;
}
