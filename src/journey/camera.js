/**
 * camera.js
 *
 * Computes the Viewport (centerLat, centerLng, zoom) for each video frame
 * based on the selected camera mode.
 *
 * Modes:
 *  'fixed'    — Static viewport showing the full journey, no movement
 *  'steady'   — Follows the current dot smoothly; zoom stays constant
 *  'dynamic'  — Follows the dot AND zooms in/out based on upcoming path density
 *  'closeup'  — Tight follow; highest zoom, shows neighbourhood-level detail
 */

import { fitZoom, centroid } from '../map/projection.js';

/**
 * @param {import('../types.js').LocationPoint[]} points  - All filtered points
 * @param {import('../types.js').AnimFrame} frame
 * @param {import('../types.js').VideoSettings} settings
 * @param {CameraState} state                             - Mutable state object (see createCameraState)
 * @returns {import('../types.js').Viewport}
 */
export function getViewport(points, frame, settings, state) {
  switch (settings.cameraMode) {
    case 'fixed':   return fixedViewport(state);
    case 'steady':  return steadyViewport(frame, state);
    case 'dynamic': return dynamicViewport(points, frame, settings, state);
    case 'closeup': return closeupViewport(frame, state);
    default:        return fixedViewport(state);
  }
}

/**
 * Create the initial camera state. Must be called once before the frame loop.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @param {import('../types.js').VideoSettings} settings
 * @returns {CameraState}
 */
export function createCameraState(points, settings) {
  const { width, height } = settings;

  // Fixed viewport: full-journey bounding box with padding
  const globalZoom = fitZoom(points, width, height, Math.min(width, height) * 0.1);
  const { lat: cLat, lng: cLng } = centroid(points);

  // Close-up and steady modes: 3 zoom levels deeper than the fixed view
  const followZoom = Math.min(17, globalZoom + 3);

  // Dynamic: same as follow but will fluctuate ±2
  const dynamicBaseZoom = Math.min(16, globalZoom + 2);

  return {
    globalZoom,
    followZoom,
    dynamicBaseZoom,
    fixedLat: cLat,
    fixedLng: cLng,
    // Smooth-follow state
    smoothLat: points[0]?.lat ?? cLat,
    smoothLng: points[0]?.lng ?? cLng,
    smoothZoom: followZoom,
  };
}

/**
 * The representative integer zoom the camera renders at for a given mode — used
 * to prefetch the right tiles. For 'dynamic' this returns the base zoom; the
 * mode fluctuates ±2 around it and any misses fall back to on-demand fetching.
 *
 * @param {CameraState} state
 * @param {import('../types.js').VideoSettings} settings
 * @returns {number}
 */
export function representativeZoom(state, settings) {
  switch (settings.cameraMode) {
    case 'fixed':   return state.globalZoom;
    case 'steady':  return state.followZoom;
    case 'closeup': return Math.min(17, state.followZoom + 1);
    case 'dynamic': return state.dynamicBaseZoom;
    default:        return state.globalZoom;
  }
}

/**
 * @typedef {Object} CameraState
 * @property {number} globalZoom
 * @property {number} followZoom
 * @property {number} dynamicBaseZoom
 * @property {number} fixedLat
 * @property {number} fixedLng
 * @property {number} smoothLat
 * @property {number} smoothLng
 * @property {number} smoothZoom
 */

// ── Mode implementations ───────────────────────────────────────────────────────

function fixedViewport(state) {
  return {
    centerLat: state.fixedLat,
    centerLng: state.fixedLng,
    zoom: state.globalZoom,
  };
}

function steadyViewport(frame, state) {
  // Exponential smoothing — lerp factor controls lag
  const α = 0.08;
  state.smoothLat += (frame.lat - state.smoothLat) * α;
  state.smoothLng += (frame.lng - state.smoothLng) * α;

  return {
    centerLat: state.smoothLat,
    centerLng: state.smoothLng,
    zoom: state.followZoom,
  };
}

function dynamicViewport(points, frame, settings, state) {
  // Look ahead ~5% of the journey to gauge how spread-out the next section is
  const lookAheadRatio = Math.min(1, frame.progressRatio + 0.05);
  const lookAheadIdx = Math.round(lookAheadRatio * (points.length - 1));
  const window = points.slice(frame.frameIndex, lookAheadIdx + 1);

  let targetZoom = state.dynamicBaseZoom;
  if (window.length >= 2) {
    // Zoom in when the upcoming path is localised
    const localZoom = fitZoom(window, settings.width, settings.height,
      Math.min(settings.width, settings.height) * 0.2);
    // Clamp to ±2 around the base
    targetZoom = Math.max(
      state.dynamicBaseZoom - 2,
      Math.min(state.dynamicBaseZoom + 2, localZoom)
    );
  }

  const α = 0.05;
  state.smoothLat  += (frame.lat  - state.smoothLat)  * α;
  state.smoothLng  += (frame.lng  - state.smoothLng)  * α;
  state.smoothZoom += (targetZoom - state.smoothZoom) * α;

  return {
    centerLat: state.smoothLat,
    centerLng: state.smoothLng,
    zoom: Math.round(state.smoothZoom), // tiles use integer zoom
  };
}

function closeupViewport(frame, state) {
  // Faster follow, higher zoom
  const α = 0.15;
  state.smoothLat += (frame.lat - state.smoothLat) * α;
  state.smoothLng += (frame.lng - state.smoothLng) * α;

  return {
    centerLat: state.smoothLat,
    centerLng: state.smoothLng,
    zoom: Math.min(17, state.followZoom + 1),
  };
}
