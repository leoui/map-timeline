/**
 * renderer.js
 *
 * Draws map tiles and the journey path onto an OffscreenCanvas.
 * Used by the compositor for both the live preview and video encoding.
 */

import { latLngToPixel, TILE_SIZE } from './projection.js';
import { fetchTile } from './tiles.js';

/**
 * Draw the map background and journey path onto a canvas.
 *
 * The trail is drawn through EXACTLY the points in `path`, and the head dot sits
 * at the last of them — so callers pass the same interpolated positions the
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
  const tileX0 = Math.floor(originPx / TILE_SIZE);
  const tileY0 = Math.floor(originPy / TILE_SIZE);
  const tileX1 = Math.ceil((originPx + width) / TILE_SIZE);
  const tileY1 = Math.ceil((originPy + height) / TILE_SIZE);

  // ── 3. Draw tiles (use cached bitmaps; skip any that 404) ──────────────────
  ctx.clearRect(0, 0, width, height);

  const tileDrawCalls = [];
  for (let tx = tileX0; tx <= tileX1; tx++) {
    for (let ty = tileY0; ty <= tileY1; ty++) {
      const destX = tx * TILE_SIZE - originPx;
      const destY = ty * TILE_SIZE - originPy;

      tileDrawCalls.push(
        fetchTile(zoom, tx, ty)
          .then((bitmap) => ctx.drawImage(bitmap, Math.round(destX), Math.round(destY)))
          .catch(() => {
            // Draw a subtle placeholder for missing tiles
            ctx.fillStyle = '#d8e0d0';
            ctx.fillRect(Math.round(destX), Math.round(destY), TILE_SIZE, TILE_SIZE);
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

  // Shadow for contrast
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 4;

  // Trail line
  ctx.beginPath();
  ctx.moveTo(canvasPts[0].x, canvasPts[0].y);
  for (let i = 1; i < canvasPts.length; i++) {
    ctx.lineTo(canvasPts[i].x, canvasPts[i].y);
  }
  ctx.strokeStyle = 'rgba(217, 26, 90, 0.65)';
  ctx.lineWidth = Math.max(2, width / 200);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  // ── 5. Draw start marker ────────────────────────────────────────────────────
  drawDot(ctx, canvasPts[0].x, canvasPts[0].y, width / 80, '#fff', '#D91A5A');

  // ── 6. Draw current position dot ──────────────────────────────────────────
  const head = canvasPts[canvasPts.length - 1];
  const dotRadius = Math.max(6, width / 60);
  drawDot(ctx, head.x, head.y, dotRadius, '#D91A5A', '#fff');

  // Pulsing ring (drawn as two concentric strokes; animation is handled by
  // compositor.js which calls this function per frame with varying alpha)
  ctx.beginPath();
  ctx.arc(head.x, head.y, dotRadius * 1.8, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(217, 26, 90, ${0.3 + 0.2 * Math.sin(pulsePhase * Math.PI * 40)})`;
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
