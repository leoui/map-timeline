/**
 * interpolate.js
 *
 * Converts a sparse set of LocationPoints (one per GPS ping, maybe minutes apart)
 * into a dense array of AnimFrames - one per video frame - by linearly
 * interpolating position along the path.
 *
 * The interpolation is arc-length-based: frames are spaced evenly along the
 * *distance* of the path, not the time axis. This keeps the dot moving at a
 * visually consistent pace regardless of whether the original data has big
 * time gaps (overnight stops, flights) or dense bursts of pings.
 */

import { haversineMetres } from '../map/projection.js';

/**
 * Build the AnimFrame array for the encoder.
 *
 * @param {import('../types.js').LocationPoint[]} points  - Filtered, sorted points
 * @param {number} totalFrames                            - fps × durationSec
 * @param {(t: number) => number} [ease]                  - Optional easing of the
 *   0..1 timeline; applied to BOTH the sampled position and progressRatio so the
 *   dot, trail, and camera all stay in lock-step. Defaults to linear.
 * @returns {import('../types.js').AnimFrame[]}
 */
export function buildFrames(points, totalFrames, ease = (t) => t) {
  if (points.length === 0) return [];
  if (points.length === 1) {
    // Single-point journey - hold still
    return Array.from({ length: totalFrames }, (_, i) => ({
      lat: points[0].lat,
      lng: points[0].lng,
      progressRatio: ease(i / (totalFrames - 1)),
      frameIndex: i,
      totalFrames,
    }));
  }

  // ── 1. Compute cumulative arc lengths ─────────────────────────────────────
  const cumDist = [0]; // metres
  for (let i = 1; i < points.length; i++) {
    const d = haversineMetres(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat,     points[i].lng
    );
    cumDist.push(cumDist[i - 1] + d);
  }
  const totalDist = cumDist[cumDist.length - 1];

  // ── 2. For each frame, find interpolated position ─────────────────────────
  const frames = [];
  let segIndex = 0; // current segment in `points`

  for (let fi = 0; fi < totalFrames; fi++) {
    const ratio = ease(fi / (totalFrames - 1));
    const targetDist = ratio * totalDist;

    // Advance segIndex until targetDist is within this segment
    while (
      segIndex < points.length - 2 &&
      cumDist[segIndex + 1] < targetDist
    ) {
      segIndex++;
    }

    const segStart = cumDist[segIndex];
    const segEnd   = cumDist[segIndex + 1] ?? segStart;
    const segLen   = segEnd - segStart;

    let t = segLen > 0 ? (targetDist - segStart) / segLen : 0;
    t = Math.max(0, Math.min(1, t));

    const a = points[segIndex];
    const b = points[Math.min(segIndex + 1, points.length - 1)];

    frames.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      progressRatio: ratio,
      frameIndex: fi,
      totalFrames,
    });
  }

  return frames;
}

/**
 * Cubic ease-in-out (smoothstep) curve: the animation accelerates at the start
 * and decelerates at the end. Pass this to buildFrames() as its `ease` argument
 * so the eased timeline drives position and progress together.
 *
 * @param {number} t  - 0..1
 * @returns {number}  - 0..1
 */
export function easeInOut(t) {
  return t * t * (3 - 2 * t);
}
