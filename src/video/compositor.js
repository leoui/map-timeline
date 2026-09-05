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
import { fitZoom, centroid, latLngToTile } from '../map/projection.js';

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
  const W = settings.width;
  const H = settings.height;

  // Photo-overlay mode: the uploaded image is the background, and the journey
  // is drawn on top of it either as a floating route line or as a mini map card.
  const photoMode = meta.backgroundMode === 'photo' && !!meta.backgroundImage;
  const overlayStyle = meta.overlayStyle === 'card' ? 'card' : 'line';

  // Region on the frame where the overlay (card or line) is drawn.
  const regionW = Math.round(W * 0.62);
  const region = { x: Math.round((W - regionW) / 2), y: Math.round(H * 0.14), w: regionW, h: regionW };

  // Precompute per-mode helpers so the frame loop stays cheap.
  let cardCanvas = null;
  let cardViewport = null;
  let lineFit = null;
  if (photoMode && overlayStyle === 'card') {
    cardCanvas = new OffscreenCanvas(region.w, region.h);
    const zoom = fitZoom(points, region.w, region.h, Math.min(region.w, region.h) * 0.12);
    const c = centroid(points);
    cardViewport = { centerLat: c.lat, centerLng: c.lng, zoom };
  } else if (photoMode && overlayStyle === 'line') {
    lineFit = buildLineFit(frames, region);
  }

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
      const path = frames.slice(0, i + 1);

      if (photoMode) {
        drawCover(ctx, meta.backgroundImage, W, H);
        if (overlayStyle === 'card') {
          // Whole-journey map inside a rounded card, with the dot progressing.
          await renderMap(cardCanvas, path, cardViewport, { pulsePhase: frame.progressRatio });
          drawRoundedImage(ctx, cardCanvas, region, 18 * (W / 540));
        } else {
          drawRouteLine(ctx, lineFit, path, W);
        }
      } else {
        // Full-frame map (the original behaviour).
        const viewport = getViewport(points, frame, settings, cameraState);
        await renderMap(canvas, path, viewport, { pulsePhase: frame.progressRatio });
      }

      drawHUD(ctx, frame, settings, meta);
    },
  };
}

// ── Photo-overlay helpers ───────────────────────────────────────────────────────

/** Draw an image to cover WxH (like CSS object-fit: cover), centred. */
function drawCover(ctx, img, W, H) {
  const ir = img.width / img.height;
  const cr = W / H;
  let dw, dh, dx, dy;
  if (ir > cr) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0; }
  else { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2; }
  ctx.drawImage(img, dx, dy, dw, dh);
}

/** Draw a source canvas into a rounded card (white border + soft shadow). */
function drawRoundedImage(ctx, src, region, r) {
  const scale = region.w / 670;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 26 * scale;
  ctx.shadowOffsetY = 8 * scale;
  ctx.fillStyle = '#fff';
  roundRect(ctx, region.x - 3, region.y - 3, region.w + 6, region.h + 6, r + 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, region.x, region.y, region.w, region.h, r);
  ctx.clip();
  ctx.drawImage(src, region.x, region.y, region.w, region.h);
  ctx.restore();
}

/**
 * Build a normalized-Mercator -> region mapping that fits the whole journey
 * into the region rectangle, preserving aspect ratio.
 */
function buildLineFit(frames, region) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of frames) {
    const t = latLngToTile(f.lat, f.lng, 0); // x,y in [0,1)
    if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
  }
  const bw = Math.max(maxX - minX, 1e-9);
  const bh = Math.max(maxY - minY, 1e-9);
  const pad = 0.14;
  const availW = region.w * (1 - 2 * pad);
  const availH = region.h * (1 - 2 * pad);
  const scale = Math.min(availW / bw, availH / bh);
  const ox = region.x + (region.w - bw * scale) / 2;
  const oy = region.y + (region.h - bh * scale) / 2;
  return { minX, minY, scale, ox, oy };
}

/** Draw the journey as a glowing floating line up to the current frame. */
function drawRouteLine(ctx, fit, path, W) {
  if (!fit || path.length < 2) return;
  const scale = W / 540;
  const pts = path.map((f) => {
    const t = latLngToTile(f.lat, f.lng, 0);
    return { x: fit.ox + (t.x - fit.minX) * fit.scale, y: fit.oy + (t.y - fit.minY) * fit.scale };
  });

  ctx.save();
  ctx.shadowColor = 'rgba(217,26,90,0.85)';
  ctx.shadowBlur = 12 * scale;
  ctx.strokeStyle = '#FF3D7F';
  ctx.lineWidth = Math.max(3, 5 * scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();

  const head = pts[pts.length - 1];
  ctx.shadowBlur = 16 * scale;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(head.x, head.y, Math.max(5, 7 * scale), 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#D91A5A';
  ctx.beginPath(); ctx.arc(head.x, head.y, Math.max(3, 4 * scale), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
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

  // ── Map attribution (bottom-left) — only when map tiles are shown ────────
  if (meta.showAttribution !== false) {
    ctx.save();
    ctx.font = `500 ${Math.round(10 * scale)}px ${FONT_STACK}`;
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = 3 * scale;
    ctx.fillStyle = 'rgba(28,15,21,0.7)';
    ctx.fillText(meta.attribution || '© OpenStreetMap contributors  © CARTO', 10 * scale, height - 8 * scale);
    ctx.restore();
  }

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
