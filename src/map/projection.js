/**
 * projection.js
 *
 * Web Mercator (EPSG:3857) utilities - the coordinate system used by
 * OpenStreetMap, Google Maps, and CARTO.
 *
 * At zoom level Z:
 *   - The world is a square of (256 * 2^Z) × (256 * 2^Z) pixels
 *   - Each tile is 256 × 256 pixels
 *   - There are 2^Z × 2^Z tiles
 */

const TILE_SIZE = 256;

/**
 * Convert a latitude / longitude to a tile coordinate at zoom level z.
 * The fractional part of x/y tells you the pixel position within the tile.
 *
 * @param {number} lat  - Decimal degrees
 * @param {number} lng  - Decimal degrees
 * @param {number} z    - Zoom level (integer)
 * @returns {{ x: number, y: number, z: number }}
 */
export function latLngToTile(lat, lng, z) {
  const scale = Math.pow(2, z);
  const x = ((lng + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y, z };
}

/**
 * Convert a tile coordinate back to lat/lng (top-left corner of the tile).
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ lat: number, lng: number }}
 */
export function tileToLatLng(x, y, z) {
  const scale = Math.pow(2, z);
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/**
 * Convert lat/lng to pixel coordinates on the full world image at zoom z.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} z
 * @returns {{ px: number, py: number }}
 */
export function latLngToPixel(lat, lng, z) {
  const { x, y } = latLngToTile(lat, lng, z);
  return { px: x * TILE_SIZE, py: y * TILE_SIZE };
}

/**
 * Convert pixel coordinates at zoom z back to lat/lng.
 *
 * @param {number} px
 * @param {number} py
 * @param {number} z
 * @returns {{ lat: number, lng: number }}
 */
export function pixelToLatLng(px, py, z) {
  return tileToLatLng(px / TILE_SIZE, py / TILE_SIZE, z);
}

/**
 * Compute the bounding box (in tile coordinates, integer) for a set of points.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @param {number} z
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number }}
 */
export function boundingTiles(points, z) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const { lat, lng } of points) {
    const { x, y } = latLngToTile(lat, lng, z);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < minX) minX = tx;
    if (tx > maxX) maxX = tx;
    if (ty < minY) minY = ty;
    if (ty > maxY) maxY = ty;
  }

  return { minX, maxX, minY, maxY };
}

/**
 * Choose an appropriate zoom level so the journey fits inside a canvas
 * of (width × height) pixels with at least `padding` pixels of margin.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} [padding=64]
 * @returns {number}
 */
export function fitZoom(points, canvasWidth, canvasHeight, padding = 64) {
  const usable = {
    w: canvasWidth - padding * 2,
    h: canvasHeight - padding * 2,
  };

  for (let z = 18; z >= 1; z--) {
    const { minX, maxX, minY, maxY } = boundingTiles(points, z);
    const pxW = (maxX - minX + 1) * TILE_SIZE;
    const pxH = (maxY - minY + 1) * TILE_SIZE;
    if (pxW <= usable.w && pxH <= usable.h) return z;
  }
  return 1;
}

/**
 * Like fitZoom, but returns a FRACTIONAL zoom so the journey fills the frame
 * as tightly as possible (the renderer scales tiles to match). Integer fitZoom
 * can leave the route up to ~2x too small because tiles only exist at whole
 * zoom levels; this avoids that.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} [padding=64]
 * @param {number} [maxZoom=17]
 * @returns {number}
 */
export function fitZoomFractional(points, canvasWidth, canvasHeight, padding = 64, maxZoom = 17) {
  if (!points || points.length === 0) return 1;
  const usableW = Math.max(1, canvasWidth - padding * 2);
  const usableH = Math.max(1, canvasHeight - padding * 2);

  // Bounding box in world pixels at zoom 0 (the world is one 256px tile there).
  let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
  for (const { lat, lng } of points) {
    const { px, py } = latLngToPixel(lat, lng, 0);
    if (px < minPx) minPx = px;
    if (px > maxPx) maxPx = px;
    if (py < minPy) minPy = py;
    if (py > maxPy) maxPy = py;
  }
  const spanX = Math.max(maxPx - minPx, 1e-6);
  const spanY = Math.max(maxPy - minPy, 1e-6);

  // Doubling zoom doubles the pixel span, so the fit zoom is log2(fit ratio).
  const z = Math.min(Math.log2(usableW / spanX), Math.log2(usableH / spanY));
  return Math.max(1, Math.min(maxZoom, z));
}

/**
 * Compute the geographic centroid of a set of points.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @returns {{ lat: number, lng: number }}
 */
export function centroid(points) {
  let sumLat = 0, sumLng = 0;
  for (const { lat, lng } of points) {
    sumLat += lat;
    sumLng += lng;
  }
  return { lat: sumLat / points.length, lng: sumLng / points.length };
}

/**
 * Haversine distance between two lat/lng points, in metres.
 *
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}  metres
 */
export function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export { TILE_SIZE };
