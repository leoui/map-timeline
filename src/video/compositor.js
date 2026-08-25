/**
 * compositor.js
 *
 * Draws a single video frame onto an OffscreenCanvas.
 * Called by encoder.js once per frame in the encoding loop.
 *
 * Each frame = map tiles + journey path (up to current position) + HUD overlay.
 */

import { renderMap } from '../map/renderer.js';
import { getViewport } from '../journey/camera.js';

/**
 * Create a Compositor for a given journey and settings.
 *
 * @param {import('../types.js').LocationPoint[]} points   - Filtered journey points
 * @param {import('../types.js').AnimFrame[]} frames       - Pre-built frame array
 * @param {import('../types.js').VideoSettings} settings
 * @param {import('../journey/camera.js').CameraState} cameraState
 * @returns {Compositor}
 */
export function createCompositor(points, frames, settings, cameraState) {
  const canvas = new OffscreenCanvas(settings.width, settings.height);
  const ctx = canvas.getContext('2d');

  return {
    canvas,

    /**
     * Draw frame `i` onto the OffscreenCanvas.
     * Caller must await this before creating a VideoFrame from canvas.
     *
     * @param {number} i  - Frame index
     * @returns {Promise<void>}
     */
    async drawFrame(i) {
      const frame = frames[i];
      const viewport = getViewport(points, frame, settings, cameraState);

      await renderMap(canvas, points, viewport, frame.progressRatio);
      drawHUD(ctx, frame, settings, viewport);
    },
  };
}

/**
 * @typedef {Object} Compositor
 * @property {OffscreenCanvas} canvas
 * @property {(i: number) => Promise<void>} drawFrame
 */

// ── HUD ───────────────────────────────────────────────────────────────────────

const HUD_PADDING   = 20;
const HUD_FONT_SM   = 13;
const HUD_FONT_MD   = 18;

/**
 * Draw the title, progress bar, and timestamp overlay.
 *
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {import('../types.js').AnimFrame} frame
 * @param {import('../types.js').VideoSettings} settings
 * @param {import('../types.js').Viewport} viewport
 */
function drawHUD(ctx, frame, settings, viewport) {
  const { width, height, title } = settings;
  const scale = width / 540; // normalise to design width 540

  // ── Title (top-left) ─────────────────────────────────────────────────────
  ctx.save();
  ctx.font = `600 ${Math.round(HUD_FONT_MD * scale)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 8 * scale;
  ctx.fillText(title, HUD_PADDING * scale, HUD_PADDING * scale + HUD_FONT_MD * scale);
  ctx.restore();

  // ── Progress bar (bottom) ────────────────────────────────────────────────
  const barH   = Math.round(4 * scale);
  const barY   = height - HUD_PADDING * scale - barH;
  const barW   = width - HUD_PADDING * scale * 2;

  // Track
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  roundRect(ctx, HUD_PADDING * scale, barY, barW, barH, barH / 2);
  ctx.fill();

  // Fill
  ctx.fillStyle = '#D91A5A';
  roundRect(ctx, HUD_PADDING * scale, barY, barW * frame.progressRatio, barH, barH / 2);
  ctx.fill();

  // ── Zoom level debug (optional — remove for production) ──────────────────
  // ctx.font = `${HUD_FONT_SM * scale}px monospace`;
  // ctx.fillStyle = 'rgba(255,255,255,0.5)';
  // ctx.fillText(`z${viewport.zoom}`, width - 60 * scale, height - 40 * scale);
}

/**
 * Path helper for rounded rectangles (replaces ctx.roundRect for older Chrome).
 */
function roundRect(ctx, x, y, w, h, r) {
  if (w <= 0) return;
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
