/**
 * @typedef {Object} LocationPoint
 * @property {number} lat          - Decimal degrees
 * @property {number} lng          - Decimal degrees
 * @property {number} timestampMs  - Unix epoch milliseconds
 * @property {number|null} [offsetMin] - Local UTC offset the point was recorded in (minutes east of UTC), or null if unknown
 */

/**
 * @typedef {Object} AnimFrame
 * @property {number} lat
 * @property {number} lng
 * @property {number} progressRatio   - 0..1 through the journey
 * @property {number} frameIndex
 * @property {number} totalFrames
 */

/**
 * @typedef {Object} VideoSettings
 * @property {string} title
 * @property {number} durationSec
 * @property {24|30|60} fps
 * @property {number} width
 * @property {number} height
 * @property {'fixed'|'steady'|'dynamic'|'closeup'} cameraMode
 * @property {'km'|'mi'} distanceUnit
 */

/**
 * @typedef {Object} Viewport
 * @property {number} centerLat
 * @property {number} centerLng
 * @property {number} zoom         - OSM zoom level 1-19
 */

/**
 * @typedef {Object} TileCoord
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

export {}; // keep this a module
