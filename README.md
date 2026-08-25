# GoogleMap Visualizer

Turn your Google Maps Timeline into a shareable MP4 — animated on a map, rendered
**entirely in your browser**. No account, no server, no upload. Your Timeline file
never leaves your device.

**Live:** https://googlemapvideo.vercel.app

---

## What it does

- Reads your exported **Google Maps Timeline** JSON (all known formats, including the
  2024+ on-device export).
- Filters GPS outliers, interpolates an even-paced path, and animates a dotted trail
  across an OpenStreetMap/CARTO basemap.
- Renders a portrait/square/landscape **MP4** using the browser's **WebCodecs**
  encoder, with a title card (title + date range + animated distance counter) and an
  optional social handle watermark.
- Everything runs client-side — the only network calls are for map tiles.

## Features

- 🎬 On-device MP4 export (H.264, with VP9 fallback)
- 🗺️ Multiple camera modes: fixed, steady, dynamic (default), close-up
- 📅 Date-range selection with live re-slicing and available-range detection
- 🧭 Animated distance counter that counts up along the drawn line
- 📱 Social handle overlay (Instagram / TikTok / Threads)
- 🌗 Light / dark theme that auto-follows the OS (with manual toggle)
- 🌐 Bilingual **English / Bahasa Indonesia** with IP + system-language auto-detection
- 🔒 Privacy-first: no uploads, no accounts, processing stays local

## Technology stack

| Area | Tech |
|---|---|
| Language | Vanilla JavaScript (ES modules), no framework |
| Build / dev | [Vite](https://vitejs.dev/) |
| Video encoding | [WebCodecs](https://www.w3.org/TR/webcodecs/) `VideoEncoder` + `VideoFrame` |
| Rendering | `OffscreenCanvas` 2D, Web Mercator (EPSG:3857) projection |
| MP4 muxing | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT) |
| Map tiles | [CARTO](https://carto.com/) basemaps · [OpenStreetMap](https://www.openstreetmap.org/) data |
| File saving | File System Access API (with a download fallback) |
| Tests | [Vitest](https://vitest.dev/) |
| Hosting | Vercel + Cloudflare (static, auto-deploy) |

## Browser support

Requires a Chromium-based browser (**Chrome / Edge 94+**) for WebCodecs +
`OffscreenCanvas`. Firefox does not yet support `VideoEncoder`; the app detects this
and shows a clear notice. HTTPS (or `localhost`) is required — WebCodecs needs a
secure context.

## Development

```bash
npm install
npm run dev      # Vite dev server on http://localhost:5173
npm run build    # production bundle → dist/
npm test         # Vitest unit tests
```

## Versioning

The version shown at the bottom of the app follows a date-based scheme:

```
Version: YYYYMMDD.C##
```

- `YYYYMMDD` — release date
- `C` — change type code:
  - **A** — Major changes
  - **X** — Minor changes
  - **U** — UI changes only
  - **Z** — New feature added
- `##` — sequence number for that day

Example: `20260826.Z01`

## Credits

- **Vibe Coded by Lewi Verdatama** — Instagram [@lverdatama](https://instagram.com/lverdatama)
- Inspired by [Google Timeline Visualizer](https://ahn-lab.org/google-timeline-visualizer/)
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · © [CARTO](https://carto.com/attribution)

Third-party software notices are available in [`public/third-party-notices.txt`](public/third-party-notices.txt).

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Google. Google Maps and Google are
trademarks of Google LLC.
