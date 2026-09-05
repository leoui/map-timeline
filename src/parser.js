/**
 * parser.js
 *
 * Parses Google Timeline JSON exports into a flat LocationPoint array.
 *
 * Google has shipped at least three incompatible formats over the years:
 *
 *  Format A  (pre-2022) - exported as "location-history.json"
 *    { locations: [ { timestampMs, latitudeE7, longitudeE7 }, … ] }
 *
 *  Format B  (2022-2024) - exported as "Records.json"
 *    { locations: [ { timestamp (ISO string), latitudeE7, longitudeE7 }, … ] }
 *
 *  Format C  (2024+) - exported as "Timeline.json" or "Semantic Location History"
 *    { semanticSegments: [ { timelinePath: [ { point, time }, … ] }, … ] }
 *    where `point` is "geo:LAT,LNG"
 *
 *  Format D  (2024+ on-device) - phone "Timeline" export, "location-history.json"
 *    A BARE top-level array of segment records, each with startTime/endTime and
 *    one of:
 *      { visit:    { topCandidate: { placeLocation: "geo:LAT,LNG" } } }
 *      { activity: { start: "geo:LAT,LNG", end: "geo:LAT,LNG" } }
 *      { timelinePath: [ { point: "geo:LAT,LNG",
 *                          durationMinutesOffsetFromStartTime: "73" }, … ] }
 *      { timelineMemory: … }   ← no coordinates, ignored
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
    // Bare array. Could be the on-device "Timeline" export (Format D) whose
    // items are visit/activity/timelinePath records, or an old-style bare list
    // of latitudeE7 locations (Format A/B).
    points = looksLikeMobileTimeline(raw)
      ? parseFormatMobile(raw)
      : parseFormatAB(raw);
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

// ── Format D (on-device "Timeline" export - bare array) ───────────────────────

/**
 * Heuristic: does this bare array look like the on-device Timeline export?
 * Checks the first handful of items for the tell-tale record keys.
 * @param {any[]} arr
 * @returns {boolean}
 */
function looksLikeMobileTimeline(arr) {
  for (const rec of arr.slice(0, 20)) {
    if (rec && typeof rec === 'object' &&
        (rec.visit || rec.activity || rec.timelinePath || rec.timelineMemory)) {
      return true;
    }
  }
  return false;
}

function parseFormatMobile(records) {
  const out = [];
  for (const rec of records) {
    const startMs = parseTimestamp(rec.startTime);
    const endMs = parseTimestamp(rec.endTime);

    // A stationary visit: one point at the start of the segment.
    if (rec.visit) {
      const coord = parseGeoPoint(rec.visit.topCandidate?.placeLocation);
      if (coord && startMs != null) {
        out.push({ lat: coord.lat, lng: coord.lng, timestampMs: startMs });
      }
    }

    // A movement activity: start point at startTime, end point at endTime.
    if (rec.activity) {
      const s = parseGeoPoint(rec.activity.start);
      const e = parseGeoPoint(rec.activity.end);
      if (s && startMs != null) out.push({ lat: s.lat, lng: s.lng, timestampMs: startMs });
      if (e && endMs != null) out.push({ lat: e.lat, lng: e.lng, timestampMs: endMs });
    }

    // A dense path: each point carries a minute offset from the segment start.
    if (Array.isArray(rec.timelinePath) && startMs != null) {
      for (const entry of rec.timelinePath) {
        const coord = parseGeoPoint(entry.point);
        if (!coord) continue;
        const offMin = Number(entry.durationMinutesOffsetFromStartTime);
        const ts = isFinite(offMin) ? startMs + offMin * 60_000 : startMs;
        out.push({ lat: coord.lat, lng: coord.lng, timestampMs: ts });
      }
    }

    // timelineMemory and any other record types carry no coordinates.
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

/**
 * Detect the "home" timezone the data was mostly recorded in, by scanning the
 * raw JSON's ISO datetimes and returning the MOST COMMON explicit UTC offset
 * (e.g. "+07:00"). Using the dominant offset means a trip that briefly crossed
 * into another zone (say GMT+9) is normalized back to the home zone (GMT+7) when
 * that single offset is applied to every point, giving one consistent timeline.
 *
 * Google Timeline visit/activity times carry the local offset; timelinePath uses
 * "Z" (UTC), so real ±HH:MM offsets are counted and "Z" only wins if nothing
 * else appears. Returns offset in minutes east of UTC, or null if none.
 *
 * @param {any} raw
 * @returns {number|null}
 */
export function detectTimezoneOffsetMin(raw) {
  const RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})/;
  const counts = new Map(); // offsetMin -> occurrences (Z excluded here)
  let sawZ = false;
  let budget = 200000; // sample cap for huge files; enough to find the majority

  const visit = (v, depth) => {
    if (depth > 8 || budget <= 0) return;
    if (typeof v === 'string') {
      budget--;
      const m = v.match(RE);
      if (m) {
        if (m[1] === 'Z' || m[1] === 'z') sawZ = true;
        else { const o = offsetStringToMin(m[1]); counts.set(o, (counts.get(o) || 0) + 1); }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && budget > 0; i++) visit(v[i], depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      for (const k in v) { if (budget <= 0) break; visit(v[k], depth + 1); }
    }
  };
  visit(raw, 0);

  if (counts.size === 0) return sawZ ? 0 : null;

  let home = null;
  let best = -1;
  for (const [offset, n] of counts) {
    if (n > best) { best = n; home = offset; }
  }
  return home;
}

/** "+07:00" | "-0530" | "Z" -> minutes east of UTC. */
function offsetStringToMin(s) {
  if (s === 'Z' || s === 'z') return 0;
  const sign = s[0] === '-' ? -1 : 1;
  const hh = parseInt(s.slice(1, 3), 10);
  const mm = parseInt(s.slice(-2), 10);
  return sign * (hh * 60 + mm);
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
