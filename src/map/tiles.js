/**
 * tiles.js
 *
 * Fetches 256×256 PNG map tiles and caches them in memory.
 *
 * Tile URL format:
 *   https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *   https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png  (preferred - no User-Agent policy)
 *
 * OSM's tile usage policy requires a descriptive User-Agent and forbids
 * high-volume automated requests. CARTO's free tier is more permissive for
 * moderate usage. Switch via TILE_PROVIDER below.
 */

import { boundingTiles, latLngToTile, TILE_SIZE } from './projection.js';

export const TILE_PROVIDERS = {
  // Street styles
  carto_light:   (z, x, y) => `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
  carto_voyager: (z, x, y) => `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  carto_dark:    (z, x, y) => `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
  osm:           (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  // Satellite imagery (Esri World Imagery — note the {z}/{y}/{x} order)
  satellite:     (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

/** Attribution text required for each provider (drawn on the video). */
export const TILE_ATTRIBUTION = {
  carto_light:   '© OpenStreetMap contributors  © CARTO',
  carto_voyager: '© OpenStreetMap contributors  © CARTO',
  carto_dark:    '© OpenStreetMap contributors  © CARTO',
  osm:           '© OpenStreetMap contributors',
  satellite:     'Imagery © Esri, Maxar, Earthstar Geographics',
};

// Change this to switch tile provider globally.
export let TILE_PROVIDER = TILE_PROVIDERS.carto_light;
export let CURRENT_ATTRIBUTION = TILE_ATTRIBUTION.carto_light;

/** @param {keyof typeof TILE_PROVIDERS} name */
export function setTileProvider(name) {
  if (!TILE_PROVIDERS[name]) throw new Error(`Unknown tile provider: ${name}`);
  TILE_PROVIDER = TILE_PROVIDERS[name];
  CURRENT_ATTRIBUTION = TILE_ATTRIBUTION[name] || TILE_ATTRIBUTION.carto_light;
  // A different provider means different tiles, so drop the cached ones.
  clearTileCache();
}

// ── In-memory cache: "{z}/{x}/{y}" → ImageBitmap ─────────────────────────────

/** @type {Map<string, ImageBitmap>} */
const cache = new Map();

/**
 * Negative cache of tile keys that failed to load. Prevents the encoder from
 * re-requesting a broken/unreachable tile once per frame (a 60s @ 30fps video
 * would otherwise retry the same failing tile ~1800 times, appearing to hang).
 * @type {Set<string>}
 */
const failed = new Set();

// Limit cache size to avoid OOM on long journeys
const MAX_CACHED_TILES = 1024;

// Abort a tile request that stalls, so one dead connection can't freeze encode.
const TILE_TIMEOUT_MS = 10_000;

function cacheKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/**
 * Build the request URL for a tile.
 *
 * We append a stable `cors=1` marker to the tile URL. CDNs (notably CARTO's)
 * can cache a copy of a tile WITHOUT an `Access-Control-Allow-Origin` header
 * when the first requester wasn't a CORS client, and then serve that headerless
 * copy to our `fetch()` - which the browser then blocks. Requesting a distinct
 * query-string variant that only this app (always a CORS client) ever asks for
 * guarantees the cached entry carries the CORS header.
 */
function tileUrl(z, x, y) {
  const base = TILE_PROVIDER(z, x, y);
  return base + (base.includes('?') ? '&' : '?') + 'cors=1';
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
  if (failed.has(key)) throw new Error(`Tile previously failed: ${key}`);

  const url = tileUrl(z, x, y);

  let bitmap;
  try {
    const response = await fetch(url, {
      mode: 'cors',
      signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    // Remember the failure so callers fall back to a placeholder immediately
    // on every subsequent frame instead of re-hitting the network.
    failed.add(key);
    throw new Error(`Tile fetch failed: ${url} → ${err.message}`);
  }

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
 * Pre-fetch the tiles the journey PATH passes through at zoom `z`, plus a
 * one-tile halo around each. Unlike prefetchTiles (which covers the whole
 * bounding box), this only warms the thin strip the camera actually follows -
 * essential for the follow/close-up camera modes, whose render zoom is several
 * levels deeper than the fit-zoom, where a full-box prefetch would be enormous
 * and mostly unused.
 *
 * @param {import('../types.js').LocationPoint[]} points
 * @param {number} z
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function prefetchAlongPath(points, z, onProgress) {
  const seen = new Set();
  const tiles = [];
  for (const { lat, lng } of points) {
    const { x, y } = latLngToTile(lat, lng, z);
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0) continue;
        const key = `${tx}/${ty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({ tx, ty });
      }
    }
  }

  const total = tiles.length;
  let loaded = 0;
  const MAX_CONCURRENT = 8;

  for (let i = 0; i < tiles.length; i += MAX_CONCURRENT) {
    const batch = tiles.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(
      batch.map(({ tx, ty }) =>
        fetchTile(z, tx, ty)
          .catch((err) => console.warn(`Skipped tile ${z}/${tx}/${ty}:`, err.message))
          .finally(() => {
            loaded++;
            onProgress?.(loaded, total);
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
  failed.clear();
}

export { TILE_SIZE };
