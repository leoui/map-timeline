/**
 * filter.js
 *
 * GPS outlier removal.
 *
 * Strategies:
 *  - 'conservative'  Remove only points that require an impossible speed
 *                    (> MAX_SPEED_KMH km/h) AND snap back near the previous
 *                    position within a short window. This targets GPS glitches
 *                    that appear as brief spikes.
 *  - 'off'           No filtering; all points pass through.
 */

import { haversineMetres } from '../map/projection.js';

// Maximum realistic speed for any common mode of transport
// (commercial aircraft ~900 km/h — set high to avoid filtering flight data)
const MAX_SPEED_KMH = 1100;

// A spike: the point is an outlier if it's faster than MAX_SPEED_KMH
// AND the *next* point is close to the point *before* the suspect one.
const SNAP_BACK_RATIO = 0.25; // next must be within 25% of prev's distance

/**
 * @param {import('../types.js').LocationPoint[]} points
 * @param {'conservative'|'off'} mode
 * @returns {import('../types.js').LocationPoint[]}
 */
export function filterOutliers(points, mode) {
  if (mode === 'off' || points.length < 3) return points;
  return conservativeFilter(points);
}

function conservativeFilter(points) {
  const out = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dtPrev = (curr.timestampMs - prev.timestampMs) / 3_600_000; // hours
    const distPrev = haversineMetres(prev.lat, prev.lng, curr.lat, curr.lng) / 1000; // km

    if (dtPrev <= 0) {
      // Duplicate or reversed timestamp — skip
      continue;
    }

    const speedKmh = distPrev / dtPrev;

    if (speedKmh > MAX_SPEED_KMH) {
      // Suspect point — check if next snaps back close to prev
      const distCurrNext = haversineMetres(curr.lat, curr.lng, next.lat, next.lng) / 1000;
      const distPrevNext = haversineMetres(prev.lat, prev.lng, next.lat, next.lng) / 1000;

      if (distPrevNext < distCurrNext * SNAP_BACK_RATIO) {
        // It's a spike — drop curr
        continue;
      }
    }

    out.push(curr);
  }

  // Always include the last point
  if (points.length > 1) out.push(points[points.length - 1]);

  return out;
}

/**
 * Compute total journey distance in metres.
 * @param {import('../types.js').LocationPoint[]} points
 * @returns {number}
 */
export function totalDistanceMetres(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMetres(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat,     points[i].lng
    );
  }
  return total;
}
