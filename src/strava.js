/**
 * strava.js
 *
 * "Connect with Strava" flow. The browser starts the OAuth redirect, then a
 * serverless function (/api/strava/*) does the token exchange (holding the
 * client secret) and proxies the Strava API. We pull one activity's GPS + time
 * streams and turn them into LocationPoint[] for the rest of the app.
 */

const CLIENT_ID = '277115'; // public Strava client id
const SCOPE = 'activity:read_all';

function redirectUri() {
  return window.location.origin + window.location.pathname;
}

/** Start the Strava OAuth flow (redirects away from the page). */
export function stravaConnect() {
  const u = new URL('https://www.strava.com/oauth/authorize');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('approval_prompt', 'auto');
  window.location.href = u.toString();
}

/**
 * Handle the OAuth redirect back (if any). Call once on page load.
 * @param {{ onActivity: (a: {points: any[], title: string}) => void,
 *           onError?: (msg: string) => void,
 *           onBusy?: (busy: boolean) => void }} cbs
 */
export async function initStrava({ onActivity, onError, onBusy }) {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const err = params.get('error');
  if (err) { cleanUrl(); onError && onError('Strava authorization was cancelled.'); return; }
  if (!code) return;
  cleanUrl();

  onBusy && onBusy(true);
  try {
    const token = await exchangeToken(code);
    const activities = await getJson('/api/strava/activities?per_page=50', token);
    onBusy && onBusy(false);
    if (!Array.isArray(activities) || activities.length === 0) {
      onError && onError('No recent activities were found on your Strava.');
      return;
    }
    showPicker(activities, async (activity) => {
      onBusy && onBusy(true);
      try {
        // Prefer the precise GPS + time stream; fall back to the route polyline.
        let points = [];
        try {
          const st = await getJson(`/api/strava/streams?id=${activity.id}`, token);
          points = streamsToPoints(st, activity);
        } catch (_) { /* fall back to the polyline below */ }
        if (points.length < 2) points = polylineToPoints(activity);
        if (points.length < 2) {
          throw new Error('That activity has no GPS route. Pick one recorded outdoors with GPS.');
        }
        onActivity({ points, title: activity.name || 'Strava activity', activity });
      } catch (e) {
        onError && onError(e.message || 'Could not load that activity.');
      } finally {
        onBusy && onBusy(false);
      }
    });
  } catch (e) {
    onBusy && onBusy(false);
    onError && onError(e.message || 'Could not connect to Strava.');
  }
}

async function exchangeToken(code) {
  const r = await fetch('/api/strava/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(data.error || 'Could not sign in to Strava. (The Strava backend may not be configured.)');
  }
  return data.access_token;
}

async function getJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Strava request failed.');
  return data;
}

function streamsToPoints(st, activity) {
  const latlng = st.latlng || [];
  const time = st.time || [];
  const startMs = Date.parse(activity.start_date) || Date.now();
  const out = [];
  for (let i = 0; i < latlng.length; i++) {
    const ll = latlng[i];
    if (!Array.isArray(ll)) continue;
    const lat = ll[0], lng = ll[1];
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      out.push({ lat, lng, timestampMs: startMs + (Number(time[i]) || i) * 1000 });
    }
  }
  return out;
}

/**
 * Fallback: build points from the activity's summary polyline (no per-point
 * timestamps, so spread the moving time evenly across the route).
 */
function polylineToPoints(activity) {
  const coords = decodePolyline(activity.polyline || '');
  if (coords.length < 2) return [];
  const startMs = Date.parse(activity.start_date) || Date.now();
  const durMs = (Number(activity.moving_time) || coords.length) * 1000;
  const n = coords.length - 1;
  return coords.map((c, i) => ({
    lat: c[0], lng: c[1], timestampMs: startMs + (durMs * i) / Math.max(1, n),
  }));
}

/** Decode a Google/Strava encoded polyline into [lat, lng] pairs. */
function decodePolyline(str) {
  if (!str) return [];
  let index = 0, lat = 0, lng = 0;
  const out = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

function cleanUrl() {
  history.replaceState({}, '', window.location.origin + window.location.pathname);
}

// ── Activity picker modal ─────────────────────────────────────────────────────

function showPicker(activities, onPick) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const head = document.createElement('div');
  head.className = 'modal-head';
  const title = document.createElement('strong');
  title.textContent = 'Choose a Strava activity';
  const close = document.createElement('button');
  close.className = 'modal-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  head.appendChild(title);
  head.appendChild(close);

  const list = document.createElement('div');
  list.className = 'activity-list';
  activities.forEach((a) => {
    const km = (a.distance / 1000).toFixed(1);
    const date = new Date(a.start_date).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    const btn = document.createElement('button');
    btn.className = 'activity';
    const name = document.createElement('div');
    name.className = 'activity-name';
    name.textContent = a.name || 'Activity';
    const meta = document.createElement('div');
    meta.className = 'activity-meta';
    meta.textContent = `${date} · ${km} km${a.type ? ' · ' + a.type : ''}${a.has_map ? '' : ' · no route'}`;
    btn.appendChild(name);
    btn.appendChild(meta);
    btn.addEventListener('click', () => { remove(); onPick(a); });
    list.appendChild(btn);
  });

  modal.appendChild(head);
  modal.appendChild(list);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function remove() { overlay.remove(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) remove(); });
  close.addEventListener('click', remove);
}
