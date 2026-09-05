/**
 * renderer.js
 *
 * Draws map tiles and the journey path onto an OffscreenCanvas.
 * Used by the compositor for both the live preview and video encoding.
 */

import { latLngToPixel, TILE_SIZE } from './projection.js';
import { fetchTile, CURRENT_PROVIDER_NAME } from './tiles.js';

/**
 * Trail/marker colours per basemap. On satellite imagery the rose brand colour
 * is easily lost against grey urban and dark-green terrain, so we switch to a
 * bright yellow with a dark casing behind it (a convention on aerial maps),
 * which stays visible over light and dark ground alike.
 */
const TRAIL_PALETTES = {
  default: {
    trail: 'rgba(217, 26, 90, 0.75)',
    casing: null,
    head: '#D91A5A', headStroke: '#fff',
    start: '#fff', startStroke: '#D91A5A',
    ring: (a) => `rgba(217, 26, 90, ${a})`,
    // Round-capped near-zero dashes render as circular dots.
    widthMul: 1, cap: 'round', dash: (w) => [0.01, w * 2.4],
  },
  satellite: {
    trail: '#FFE000',
    casing: 'rgba(0, 0, 0, 0.55)',
    head: '#FFE000', headStroke: '#1a1a1a',
    start: '#1a1a1a', startStroke: '#FFE000',
    ring: (a) => `rgba(255, 224, 0, ${a})`,
    // A thicker dashed line with roomy gaps, easier to follow over imagery.
    widthMul: 1.7, cap: 'butt', dash: (w) => [w * 3, w * 2.6],
  },
};

function trailPalette() {
  return CURRENT_PROVIDER_NAME === 'satellite' ? TRAIL_PALETTES.satellite : TRAIL_PALETTES.default;
}

/**
 * User-adjustable trail tuning, applied on top of the per-basemap palette:
 *   widthMul - overall line-thickness multiplier
 *   gapMul   - spacing multiplier (larger = more spread out dashes/dots)
 */
let trailWidthMul = 1;
let trailGapMul = 1;

/** @param {{ widthMul?: number, gapMul?: number }} s */
export function setTrailStyle(s = {}) {
  if (Number.isFinite(s.widthMul)) trailWidthMul = s.widthMul;
  if (Number.isFinite(s.gapMul)) trailGapMul = s.gapMul;
}

/**
 * Draw the map background and journey path onto a canvas.
 *
 * The trail is drawn through EXACTLY the points in `path`, and the head dot sits
 * at the last of them - so callers pass the same interpolated positions the
 * camera is centred on, keeping dot, trail, and camera in sync. For the video
 * this is frames[0..current]; for the static preview it's the full journey.
 *
 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
 * @param {{lat:number,lng:number}[]} path            - Trail points to draw (head = last)
 * @param {import('../types.js').Viewport} viewport   - Current camera viewport
 * @param {{ pulsePhase?: number }} [opts]            - pulsePhase drives the head ring (0..1)
 * @returns {Promise<void>}
 */
export async function renderMap(canvas, path, viewport, opts = {}) {
  const { pulsePhase = 1 } = opts;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const { centerLat, centerLng, zoom } = viewport;

  // ── 1. Compute origin pixel (top-left of canvas in world-pixel coords) ──────
  const center = latLngToPixel(centerLat, centerLng, zoom);
  const originPx = center.px - width / 2;
  const originPy = center.py - height / 2;

  // ── 2. Determine tile range needed ─────────────────────────────────────────
  // `zoom` may be fractional (for a tight fit). Fetch tiles at the nearest
  // integer zoom and scale them, so the route can fill the frame instead of
  // being stuck one integer level too far out.
  const tileZoom = Math.max(0, Math.round(zoom));
  const tileScale = Math.pow(2, zoom - tileZoom); // 1 when zoom is integer
  const tileWorld = TILE_SIZE * tileScale;         // on-screen size of one tile
  const worldTiles = Math.pow(2, tileZoom);        // tiles per axis at tileZoom

  const tileX0 = Math.floor(originPx / tileWorld);
  const tileY0 = Math.floor(originPy / tileWorld);
  const tileX1 = Math.ceil((originPx + width) / tileWorld);
  const tileY1 = Math.ceil((originPy + height) / tileWorld);

  // ── 3. Draw tiles (use cached bitmaps; skip any that 404) ──────────────────
  ctx.clearRect(0, 0, width, height);
  // Paint a water-coloured base first so any uncovered area (poles at low zoom,
  // tiles still loading) reads as ocean instead of a blank card-coloured gap.
  ctx.fillStyle = '#dfe6ea';
  ctx.fillRect(0, 0, width, height);

  const drawW = Math.ceil(tileWorld) + 1; // +1 avoids hairline seams between tiles

  const tileDrawCalls = [];
  for (let tx = tileX0; tx <= tileX1; tx++) {
    for (let ty = tileY0; ty <= tileY1; ty++) {
      // Above/below the map (poles) there are no tiles - leave the water base.
      if (ty < 0 || ty >= worldTiles) continue;

      const destX = tx * tileWorld - originPx;
      const destY = ty * tileWorld - originPy;
      // Wrap longitude so a world-spanning journey fills the whole canvas
      // instead of leaving a blank strip past the antimeridian.
      const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles;

      tileDrawCalls.push(
        fetchTile(tileZoom, wrappedX, ty)
          .then((bitmap) => ctx.drawImage(bitmap, Math.floor(destX), Math.floor(destY), drawW, drawW))
          .catch(() => {
            // Draw a subtle placeholder for missing tiles
            ctx.fillStyle = '#d8e0d0';
            ctx.fillRect(Math.floor(destX), Math.floor(destY), drawW, drawW);
          })
      );
    }
  }

  await Promise.all(tileDrawCalls);

  // ── 4. Draw journey path ────────────────────────────────────────────────────
  if (!path || path.length < 2) return;

  // Convert the trail points to canvas pixel coordinates
  const canvasPts = path.map(({ lat, lng }) => {
    const { px, py } = latLngToPixel(lat, lng, zoom);
    return { x: px - originPx, y: py - originPy };
  });

  const pal = trailPalette();
  const lineWidth = Math.max(2, width / 200) * (pal.widthMul || 1) * trailWidthMul;
  // Base dash from the palette, with the gap scaled by the user's spacing slider.
  const baseDash = pal.dash(lineWidth);
  const dash = [baseDash[0], baseDash[1] * trailGapMul];

  // Optional dark casing behind the trail so a bright line stays legible over
  // both light and dark ground (used on satellite imagery).
  if (pal.casing) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(canvasPts[0].x, canvasPts[0].y);
    for (let i = 1; i < canvasPts.length; i++) ctx.lineTo(canvasPts[i].x, canvasPts[i].y);
    ctx.strokeStyle = pal.casing;
    ctx.lineWidth = lineWidth * 1.7;
    ctx.lineJoin = 'round';
    ctx.lineCap = pal.cap;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
  }

  // Shadow for contrast
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 4;

  // Trail line - dotted. (setLineDash is part of the saved drawing state, so the
  // restore() below clears it before the solid dots/rings are drawn.)
  ctx.beginPath();
  ctx.moveTo(canvasPts[0].x, canvasPts[0].y);
  for (let i = 1; i < canvasPts.length; i++) {
    ctx.lineTo(canvasPts[i].x, canvasPts[i].y);
  }
  ctx.strokeStyle = pal.trail;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = pal.cap;
  // Dots (round-capped near-zero dashes) or dashes, per the basemap palette; the
  // pattern scales with line width so spacing looks consistent across sizes.
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.restore();

  // ── 5. Draw start marker ────────────────────────────────────────────────────
  drawDot(ctx, canvasPts[0].x, canvasPts[0].y, width / 80, pal.start, pal.startStroke);

  // ── 6. Draw current position dot ──────────────────────────────────────────
  const head = canvasPts[canvasPts.length - 1];
  const dotRadius = Math.max(6, width / 60);
  drawDot(ctx, head.x, head.y, dotRadius, pal.head, pal.headStroke);

  // Pulsing ring (drawn as two concentric strokes; animation is handled by
  // compositor.js which calls this function per frame with varying alpha)
  ctx.beginPath();
  ctx.arc(head.x, head.y, dotRadius * 1.8, 0, Math.PI * 2);
  ctx.strokeStyle = pal.ring(0.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 40));
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * Draw a filled circle with an outline.
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 */
function drawDot(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1.5, r / 4);
  ctx.stroke();
}
