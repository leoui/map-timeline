/**
 * sample-data.js
 *
 * A fictional multi-city journey for testing without a real Timeline.json.
 * Route: Seoul → Tokyo → Singapore → London → New York → Seoul
 *
 * Each segment has dense local pings interspersed with the long-haul flights.
 */

const MS_PER_DAY = 86_400_000;
const BASE = Date.parse('2026-01-01T00:00:00Z');

/** @returns {import('./types.js').LocationPoint[]} */
export function samplePoints() {
  const pts = [];

  // Helper to add a cluster of points around a city over a given time window
  const cluster = (lat, lng, startMs, endMs, count) => {
    for (let i = 0; i < count; i++) {
      const t = startMs + ((endMs - startMs) * i) / (count - 1);
      pts.push({
        lat: lat + (Math.random() - 0.5) * 0.05,
        lng: lng + (Math.random() - 0.5) * 0.05,
        timestampMs: Math.round(t),
      });
    }
  };

  // Helper to add a flight segment between two cities
  const flight = (lat1, lng1, lat2, lng2, startMs, endMs, steps = 20) => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({
        lat: lat1 + (lat2 - lat1) * t,
        lng: lat1 > lat2 && lng1 > lng2 ? lng1 + (lng2 - lng1) * t : lng1 + (lng2 - lng1) * t,
        timestampMs: Math.round(startMs + (endMs - startMs) * t),
      });
    }
  };

  // Seoul — Day 0–3
  cluster(37.5665, 126.978, BASE, BASE + MS_PER_DAY * 3, 120);

  // Seoul → Tokyo flight — Day 3
  flight(37.5665, 126.978, 35.6762, 139.6503,
    BASE + MS_PER_DAY * 3, BASE + MS_PER_DAY * 3.1);

  // Tokyo — Day 3–7
  cluster(35.6762, 139.6503, BASE + MS_PER_DAY * 3.1, BASE + MS_PER_DAY * 7, 180);

  // Tokyo → Singapore flight — Day 7
  flight(35.6762, 139.6503, 1.3521, 103.8198,
    BASE + MS_PER_DAY * 7, BASE + MS_PER_DAY * 7.3);

  // Singapore — Day 7–10
  cluster(1.3521, 103.8198, BASE + MS_PER_DAY * 7.3, BASE + MS_PER_DAY * 10, 100);

  // Singapore → London flight — Day 10
  flight(1.3521, 103.8198, 51.5074, -0.1278,
    BASE + MS_PER_DAY * 10, BASE + MS_PER_DAY * 10.5);

  // London — Day 10–15
  cluster(51.5074, -0.1278, BASE + MS_PER_DAY * 10.5, BASE + MS_PER_DAY * 15, 200);

  // London → New York flight — Day 15
  flight(51.5074, -0.1278, 40.7128, -74.006,
    BASE + MS_PER_DAY * 15, BASE + MS_PER_DAY * 15.4);

  // New York — Day 15–20
  cluster(40.7128, -74.006, BASE + MS_PER_DAY * 15.4, BASE + MS_PER_DAY * 20, 160);

  // New York → Seoul flight (Pacific crossing, simulate longitude wrap) — Day 20
  // Split into two legs to handle the antimeridian crossing
  flight(40.7128, -74.006, 51.5, -170,
    BASE + MS_PER_DAY * 20, BASE + MS_PER_DAY * 20.3, 10);
  flight(51.5, 170, 37.5665, 126.978,
    BASE + MS_PER_DAY * 20.3, BASE + MS_PER_DAY * 20.6, 10);

  // Back in Seoul — Day 20–21
  cluster(37.5665, 126.978, BASE + MS_PER_DAY * 20.6, BASE + MS_PER_DAY * 21, 40);

  return pts.sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Summary metadata for the sample, for display in the UI. */
export const SAMPLE_META = {
  filename: 'fictional-sample-journey.json',
  description: 'Seoul → Tokyo → Singapore → London → New York → Seoul',
  startMs: BASE,
  endMs: BASE + MS_PER_DAY * 21,
};
