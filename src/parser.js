/**
 * parser.js
 *
 * Parses Google Timeline JSON exports into a flat LocationPoint array.
 *
 * Google has shipped at least three incompatible formats over the years:
 *
 *  Format A  (pre-2022) — exported as "location-history.json"
 *    { locations: [ { timestampMs, latitudeE7, longitudeE7 }, … ] }
 *
 *  Format B  (2022–2024) — exported as "Records.json"
 *    { locations: [ { timestamp (ISO string), latitudeE7, longitudeE7 }, … ] }
 *
 *  Format C  (2024+) — exported as "Timeline.json" or "Semantic Location History"
 *    { semanticSegments: [ { timelinePath: [ { point, time }, … ] }, … ] }
 *    where `point` is "geo:LAT,LNG"
 *
 * This module tries each format in order and falls back gracefully.
 */

/**
 * Parse raw JSON object into LocationPoint[].
 * Throws a descriptive Error if no recognisable format is found.
 *
 * @param {object} raw - Parsed JSON from the uploaded file
 * @param {{ startMs?: number, endMs?: number }} [opts]
 * @returns {import('./types.js').LocationPoint[]}
 */
export function parseTimeline(raw, opts = {}) {
  const { startMs = -Infinity, endMs = Infinity } = opts;

  let points;

  if (Array.isArray(raw?.locations)) {
    points = parseFormatAB(raw.locations);
  } else if (Array.isArray(raw?.semanticSegments)) {
    points = parseFormatC(raw.semanticSegments);
  } else if (Array.isArray(raw?.timelineObjects)) {
    // Some exports wrap everything in timelineObjects
    points = parseTimelineObjects(raw.timelineObjects);
  } else if (Array.isArray(raw)) {
    // Bare array — try treating each item as a location
    points = parseFormatAB(raw);
  } else {
    throw new Error(
      'Unrecognised Timeline format. Expected a JSON file exported from Google Maps Timeline.'
    );
  }

  // Date filter
  const filtered = points.filter(
    (p) => p.timestampMs >= startMs && p.timestampMs <= endMs
  );

  if (filtered.length === 0) {
    throw new Error(
      'No location points found in the selected date range. Try widening the date range.'
    );
  }

  // Sort chronologically (some exports are not sorted)
  return filtered.sort((a, b) => a.timestampMs - b.timestampMs);
}

// ── Format A / B ─────────────────────────────────────────────────────────────

function parseFormatAB(locations) {
  const out = [];
  for (const loc of locations) {
    const lat = loc.latitudeE7 != null ? loc.latitudeE7 / 1e7 : loc.latitude;
    const lng = loc.longitudeE7 != null ? loc.longitudeE7 / 1e7 : loc.longitude;
    const ts = parseTimestamp(loc.timestampMs ?? loc.timestamp);

    if (!isValidCoord(lat, lng) || ts == null) continue;
    out.push({ lat, lng, timestampMs: ts });
  }
  return out;
}

// ── Format C (semanticSegments) ───────────────────────────────────────────────

function parseFormatC(segments) {
  const out = [];
  for (const seg of segments) {
    const path = seg.timelinePath ?? [];
    for (const entry of path) {
      const coord = parseGeoPoint(entry.point);
      const ts = parseTimestamp(entry.time);
      if (!coord || ts == null) continue;
      out.push({ lat: coord.lat, lng: coord.lng, timestampMs: ts });
    }

    // Also pull start/end of any placeVisit or activitySegment if present
    if (seg.startLocation) {
      const ts = parseTimestamp(seg.startTime);
      const lat = (seg.startLocation.latitudeE7 ?? 0) / 1e7;
      const lng = (seg.startLocation.longitudeE7 ?? 0) / 1e7;
      if (isValidCoord(lat, lng) && ts != null) out.push({ lat, lng, timestampMs: ts });
    }
  }
  return out;
}

// ── Legacy timelineObjects ────────────────────────────────────────────────────

function parseTimelineObjects(objects) {
  const out = [];
  for (const obj of objects) {
    const pv = obj.placeVisit;
    const as = obj.activitySegment;

    if (pv?.location) {
      const lat = (pv.location.latitudeE7 ?? 0) / 1e7;
      const lng = (pv.location.longitudeE7 ?? 0) / 1e7;
      const ts = parseTimestamp(pv.duration?.startTimestampMs ?? pv.duration?.startTimestamp);
      if (isValidCoord(lat, lng) && ts != null) out.push({ lat, lng, timestampMs: ts });
    }

    if (as?.startLocation) {
      const lat = (as.startLocation.latitudeE7 ?? 0) / 1e7;
      const lng = (as.startLocation.longitudeE7 ?? 0) / 1e7;
      const ts = parseTimestamp(as.duration?.startTimestampMs ?? as.duration?.startTimestamp);
      if (isValidCoord(lat, lng) && ts != null) out.push({ lat, lng, timestampMs: ts });
    }

    if (as?.waypointPath?.waypoints) {
      for (const wp of as.waypointPath.waypoints) {
        const lat = (wp.latE7 ?? 0) / 1e7;
        const lng = (wp.lngE7 ?? 0) / 1e7;
        if (isValidCoord(lat, lng)) out.push({ lat, lng, timestampMs: 0 });
      }
    }
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse "geo:12.345,-67.890" → { lat, lng }
 * @param {string} str
 */
function parseGeoPoint(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^geo:([-\d.]+),([-\d.]+)/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
}

/**
 * Parse a timestamp that may be a number (ms), string (ms or ISO), or null.
 * Returns Unix milliseconds or null.
 * @param {string|number|null|undefined} v
 */
function parseTimestamp(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // ISO 8601
    if (v.includes('T') || v.includes('-')) {
      const ms = Date.parse(v);
      return isNaN(ms) ? null : ms;
    }
    // Numeric string (ms)
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

function isValidCoord(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    isFinite(lat) &&
    isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

/**
 * Summarise a parsed timeline for display in the UI.
 * @param {import('./types.js').LocationPoint[]} points
 * @returns {{ count: number, startMs: number, endMs: number }}
 */
export function summarise(points) {
  if (points.length === 0) return { count: 0, startMs: 0, endMs: 0 };
  return {
    count: points.length,
    startMs: points[0].timestampMs,
    endMs: points[points.length - 1].timestampMs,
  };
}
