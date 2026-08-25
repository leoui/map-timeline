/**
 * progress.js
 *
 * A lightweight event bus for reporting pipeline progress to the UI.
 * All pipeline modules call emit(); the UI subscribes with on().
 */

/** @type {Map<string, Function[]>} */
const listeners = new Map();

/**
 * Subscribe to a progress event.
 *
 * Events emitted by the pipeline:
 *  'tiles:start'      { total: number }
 *  'tiles:progress'   { loaded: number, total: number }
 *  'tiles:done'       {}
 *  'encode:start'     { total: number }
 *  'encode:progress'  { encoded: number, total: number }
 *  'encode:done'      {}
 *  'mux:start'        {}
 *  'mux:done'         { sizeBytes: number }
 *  'error'            { message: string }
 *
 * @param {string} event
 * @param {Function} handler
 */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(handler);
}

/**
 * Remove a specific handler (or all handlers for an event if handler omitted).
 * @param {string} event
 * @param {Function} [handler]
 */
export function off(event, handler) {
  if (!handler) { listeners.delete(event); return; }
  const arr = listeners.get(event);
  if (!arr) return;
  const idx = arr.indexOf(handler);
  if (idx !== -1) arr.splice(idx, 1);
}

/**
 * Emit a progress event.
 * @param {string} event
 * @param {object} [data]
 */
export function emit(event, data = {}) {
  (listeners.get(event) ?? []).forEach((h) => h(data));
  (listeners.get('*') ?? []).forEach((h) => h(event, data)); // wildcard listeners
}

/**
 * Remove all listeners (call on journey reset).
 */
export function reset() {
  listeners.clear();
}

/**
 * Convenience: wire up standard DOM progress elements.
 *
 * @param {{
 *   labelEl: HTMLElement,
 *   fillEl: HTMLElement,
 *   statusEl?: HTMLElement,
 * }} els
 */
export function bindToDOM({ labelEl, fillEl, statusEl }) {
  on('tiles:start', ({ total }) => {
    setLabel(labelEl, `Fetching map tiles (0 / ${total})…`);
    setFill(fillEl, 0);
  });

  on('tiles:progress', ({ loaded, total }) => {
    setLabel(labelEl, `Fetching map tiles (${loaded} / ${total})…`);
    setFill(fillEl, (loaded / total) * 30); // tiles = 0–30%
  });

  on('tiles:done', () => {
    setLabel(labelEl, 'Map tiles ready.');
  });

  on('encode:start', ({ total }) => {
    setLabel(labelEl, `Encoding video… (0 / ${total} frames)`);
  });

  on('encode:progress', ({ encoded, total }) => {
    const pct = 30 + (encoded / total) * 60; // encoding = 30–90%
    setLabel(labelEl, `Encoding video… (${encoded} / ${total} frames)`);
    setFill(fillEl, pct);
  });

  on('encode:done', () => {
    setLabel(labelEl, 'Encoding complete — writing MP4…');
    setFill(fillEl, 90);
  });

  on('mux:start', () => {
    setLabel(labelEl, 'Writing MP4…');
  });

  on('mux:done', ({ sizeBytes }) => {
    const mb = (sizeBytes / 1_048_576).toFixed(1);
    setLabel(labelEl, `Video ready · ${mb} MB`);
    setFill(fillEl, 100);
    if (statusEl) statusEl.textContent = `✓ Download started (${mb} MB)`;
  });

  on('error', ({ message }) => {
    setLabel(labelEl, `Error: ${message}`);
    if (statusEl) statusEl.textContent = `✗ ${message}`;
  });
}

function setLabel(el, text) { if (el) el.textContent = text; }
function setFill(el, pct)   { if (el) el.style.width = `${Math.round(pct)}%`; }
