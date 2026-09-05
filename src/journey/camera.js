/**
 * camera.js
 *
 * Computes the Viewport (centerLat, centerLng, zoom) for each video frame
 * based on the selected camera mode.
 *
 * Modes:
 *  'fixed'    - Static viewport showing the full journey, no movement
 *  'steady'   - Follows the current dot smoothly; zoom stays constant
 *  'dynamic'  - Follows the dot AND zooms in/out based on upcoming path density
 *  'closeup'  - Tight follow; highest zoom, shows neighbourhood-level detail
 */

import { fitZoom, fitZoomFractional, centroid, latLngToPixel, pixelToLatLng } from '../map/projection.js';

/**
 * Nudge a (smoothed) camera centre so the moving dot stays within a central
 * safe zone - `marginFrac` of the half-viewport from centre. Light exponential
 * smoothing alone lags without bound when the journey moves fast, letting the
 * dot run off-screen; this guarantees the dot is always framed while still
 * allowing smooth drift when motion is slow.
 *
 * @returns {{ centerLat: number, centerLng: number }}
 */
function clampCenterToDot(centerLat, centerLng, dotLat, dotLng, zoom, settings, marginFrac = 0.35) {
  const c = latLngToPixel(centerLat, centerLng, zoom);
  const h = latLngToPixel(dotLat, dotLng, zoom);
  const maxX = settings.width * 0.5 * marginFrac;
  const maxY = settings.height * 0.5 * marginFrac;

  let cx = c.px;
  let cy = c.py;
  const dx = h.px - cx;
  const dy = h.py - cy;
  if (dx > maxX) cx += dx - maxX; else if (dx < -maxX) cx += dx + maxX;
  if (dy > maxY) cy += dy - maxY; else if (dy < -maxY) cy += dy + maxY;

  const ll = pixelToLatLng(cx, cy, zoom);
  return { centerLat: ll.lat, centerLng: ll.lng };
}

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
    case 'steady':  return steadyViewport(frame, settings, state);
    case 'dynamic': return dynamicViewport(points, frame, settings, state);
    case 'closeup': return closeupViewport(frame, settings, state);
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

  // Fixed viewport: full-journey bounding box with padding. Fractional so the
  // route fills the frame (both endpoints clearly visible), not stuck an
  // integer zoom level too far out.
  const globalZoom = fitZoomFractional(points, width, height, Math.min(width, height) * 0.12);
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
 * The representative integer zoom the camera renders at for a given mode - used
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

function steadyViewport(frame, settings, state) {
  // Exponential smoothing for a cinematic drift…
  const α = 0.15;
  state.smoothLat += (frame.lat - state.smoothLat) * α;
  state.smoothLng += (frame.lng - state.smoothLng) * α;

  // …then clamp so the dot stays framed (and write back so lag can't accumulate).
  const { centerLat, centerLng } = clampCenterToDot(
    state.smoothLat, state.smoothLng, frame.lat, frame.lng, state.followZoom, settings
  );
  state.smoothLat = centerLat;
  state.smoothLng = centerLng;

  return { centerLat, centerLng, zoom: state.followZoom };
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

  const α = 0.12;
  state.smoothLat  += (frame.lat  - state.smoothLat)  * α;
  state.smoothLng  += (frame.lng  - state.smoothLng)  * α;
  state.smoothZoom += (targetZoom - state.smoothZoom) * α;

  const zoom = Math.round(state.smoothZoom); // tiles use integer zoom
  const { centerLat, centerLng } = clampCenterToDot(
    state.smoothLat, state.smoothLng, frame.lat, frame.lng, zoom, settings
  );
  state.smoothLat = centerLat;
  state.smoothLng = centerLng;

  return { centerLat, centerLng, zoom };
}

function closeupViewport(frame, settings, state) {
  // Faster follow, higher zoom, tighter safe zone.
  const zoom = Math.min(17, state.followZoom + 1);
  const α = 0.25;
  state.smoothLat += (frame.lat - state.smoothLat) * α;
  state.smoothLng += (frame.lng - state.smoothLng) * α;

  const { centerLat, centerLng } = clampCenterToDot(
    state.smoothLat, state.smoothLng, frame.lat, frame.lng, zoom, settings, 0.25
  );
  state.smoothLat = centerLat;
  state.smoothLng = centerLng;

  return { centerLat, centerLng, zoom };
}
