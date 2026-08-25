/**
 * tiles.js
 *
 * Fetches 256×256 PNG map tiles and caches them in memory.
 *
 * Tile URL format:
 *   https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *   https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png  (preferred — no User-Agent policy)
 *
 * OSM's tile usage policy requires a descriptive User-Agent and forbids
 * high-volume automated requests. CARTO's free tier is more permissive for
 * moderate usage. Switch via TILE_PROVIDER below.
 */

import { boundingTiles, TILE_SIZE } from './projection.js';

export const TILE_PROVIDERS = {
  osm:         (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  carto_light: (z, x, y) => `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
  carto_dark:  (z, x, y) => `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
};

// Change this to switch tile provider globally.
export let TILE_PROVIDER = TILE_PROVIDERS.carto_light;

/** @param {'osm'|'carto_light'|'carto_dark'} name */
export function setTileProvider(name) {
  if (!TILE_PROVIDERS[name]) throw new Error(`Unknown tile provider: ${name}`);
  TILE_PROVIDER = TILE_PROVIDERS[name];
}

// ── In-memory cache: "{z}/{x}/{y}" → ImageBitmap ─────────────────────────────

/** @type {Map<string, ImageBitmap>} */
const cache = new Map();

// Limit cache size to avoid OOM on long journeys
const MAX_CACHED_TILES = 1024;

function cacheKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/**
 * Fetch a single tile and return it as an ImageBitmap, using the cache.
 *
 * @param {number} z
 * @param {number} x  - Tile x (integer)
 * @param {number} y  - Tile y (integer)
 * @returns {Promise<ImageBitmap>}
 */
export async function fetchTile(z, x, y) {
  const key = cacheKey(z, x, y);
  if (cache.has(key)) return cache.get(key);

  const url = TILE_PROVIDER(z, x, y);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Tile fetch failed: ${url} → HTTP ${response.status}`);
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHED_TILES) {
    const firstKey = cache.keys().next().value;
    const evicted = cache.get(firstKey);
    evicted.close();
    cache.delete(firstKey);
  }

  cache.set(key, bitmap);
  return bitmap;
}

/**
 * Pre-fetch all tiles covering the journey's bounding box at zoom z.
 * Call this before starting the encoder loop so tile fetches don't stall encoding.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @param {number} z
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function prefetchTiles(points, z, onProgress) {
  const { minX, maxX, minY, maxY } = boundingTiles(points, z);

  // Add 1-tile buffer on all sides
  const x0 = Math.max(0, minX - 1);
  const x1 = maxX + 1;
  const y0 = Math.max(0, minY - 1);
  const y1 = maxY + 1;

  const tileCount = (x1 - x0 + 1) * (y1 - y0 + 1);
  const MAX_CONCURRENT = 8;

  let loaded = 0;
  const queue = [];

  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      queue.push({ tx, ty });
    }
  }

  // Process in batches to respect the concurrent connection limit
  for (let i = 0; i < queue.length; i += MAX_CONCURRENT) {
    const batch = queue.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(
      batch.map(({ tx, ty }) =>
        fetchTile(z, tx, ty)
          .catch((err) => console.warn(`Skipped tile ${z}/${tx}/${ty}:`, err.message))
          .finally(() => {
            loaded++;
            onProgress?.(loaded, tileCount);
          })
      )
    );
  }
}

/**
 * Release all cached ImageBitmaps (call when the journey changes or the page unloads).
 */
export function clearTileCache() {
  for (const bitmap of cache.values()) bitmap.close();
  cache.clear();
}

export { TILE_SIZE };
