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
 * @param {{ dateLabel?: string, totalMeters?: number, distanceUnit?: string }} [meta]
 * @returns {Compositor}
 */
export function createCompositor(points, frames, settings, cameraState, meta = {}) {
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

      // Trail = the interpolated positions up to and including this frame, so
      // the drawn line ends exactly at the head dot the camera is following.
      const path = frames.slice(0, i + 1);
      await renderMap(canvas, path, viewport, { pulsePhase: frame.progressRatio });
      drawHUD(ctx, frame, settings, meta);
    },
  };
}

/**
 * @typedef {Object} Compositor
 * @property {OffscreenCanvas} canvas
 * @property {(i: number) => Promise<void>} drawFrame
 */

// ── HUD ───────────────────────────────────────────────────────────────────────

const FONT_STACK = 'Inter, system-ui, sans-serif';

/**
 * Draw the top title card (title + "date range | animated distance") and the
 * map attribution in the bottom-left corner.
 *
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {import('../types.js').AnimFrame} frame
 * @param {import('../types.js').VideoSettings} settings
 * @param {{ dateLabel?: string, totalMeters?: number, distanceUnit?: string }} meta
 */
function drawHUD(ctx, frame, settings, meta) {
  const { width, height, title } = settings;
  const scale = width / 540; // normalise to a 540px design width

  // ── Animated distance (0 → total, along the drawn line) ──────────────────
  const totalMeters = meta.totalMeters || 0;
  const metersSoFar = totalMeters * frame.progressRatio;
  const distStr = formatDistance(metersSoFar, meta.distanceUnit);

  const subtitle = meta.dateLabel ? `${meta.dateLabel} | ${distStr}` : distStr;

  // ── Card geometry ────────────────────────────────────────────────────────
  const titlePx = Math.round(21 * scale);
  const subPx   = Math.round(13 * scale);
  const padX    = 24 * scale;
  const padY    = 15 * scale;
  const lineGap = 7 * scale;
  const topMargin = 20 * scale;
  const maxCardW  = width - 32 * scale;

  const titleFont = `600 ${titlePx}px ${FONT_STACK}`;
  const subFont   = `500 ${subPx}px ${FONT_STACK}`;

  ctx.textBaseline = 'top';
  ctx.font = titleFont;
  const drawTitle = ellipsize(ctx, title || '', maxCardW - padX * 2);
  const titleW = ctx.measureText(drawTitle).width;
  ctx.font = subFont;
  const subW = ctx.measureText(subtitle).width;

  const contentW = Math.max(titleW, subW);
  const cardW = Math.min(contentW + padX * 2, maxCardW);
  const cardH = padY * 2 + titlePx + lineGap + subPx;
  const cardX = (width - cardW) / 2;
  const cardY = topMargin;

  // Card background
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.20)';
  ctx.shadowBlur = 18 * scale;
  ctx.shadowOffsetY = 5 * scale;
  ctx.fillStyle = 'rgba(255,255,255,0.93)';
  roundRect(ctx, cardX, cardY, cardW, cardH, 16 * scale);
  ctx.fill();
  ctx.restore();

  // Title + subtitle, centred
  ctx.textAlign = 'center';
  const cx = width / 2;

  ctx.font = titleFont;
  ctx.fillStyle = '#1C0F15';
  ctx.fillText(drawTitle, cx, cardY + padY);

  ctx.font = subFont;
  ctx.fillStyle = '#7D5F6D';
  ctx.fillText(subtitle, cx, cardY + padY + titlePx + lineGap);
  ctx.textAlign = 'left';

  // ── Map attribution (bottom-left) ────────────────────────────────────────
  ctx.save();
  ctx.font = `500 ${Math.round(10 * scale)}px ${FONT_STACK}`;
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(255,255,255,0.7)';
  ctx.shadowBlur = 3 * scale;
  ctx.fillStyle = 'rgba(28,15,21,0.7)';
  ctx.fillText(meta.attribution || '© OpenStreetMap contributors  © CARTO', 10 * scale, height - 8 * scale);
  ctx.restore();

  // ── Social handle (bottom-right) - same styling as the attribution ───────
  const handle = (settings.socialHandle || '').trim();
  if (handle) {
    const platform = settings.socialPlatform || 'Instagram';
    const label = `${platform}: @${handle}`;
    ctx.save();
    ctx.font = `500 ${Math.round(10 * scale)}px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = 3 * scale;
    ctx.fillStyle = 'rgba(28,15,21,0.7)';
    ctx.fillText(label, width - 10 * scale, height - 8 * scale);
    ctx.restore();
  }
}

/**
 * Format a distance in metres to a rounded "N km" / "N mi" string.
 * @param {number} meters
 * @param {string} [unit] - 'mi' for miles, otherwise kilometres
 * @returns {string}
 */
function formatDistance(meters, unit) {
  if (unit === 'mi') return `${Math.round(meters / 1609.34).toLocaleString()} mi`;
  return `${Math.round(meters / 1000).toLocaleString()} km`;
}

/**
 * Trim text with an ellipsis so it fits within maxWidth at the current font.
 */
function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '…';
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
