# Recap Music

Recaps automatically play background music as soon as audio files are present
in the music folder. Without files, recaps simply play silently — no further
configuration is needed.

## Folder Structure

The folder is configured via the environment variable `RECAPS_MUSIC_DIR`
(default: `/mnt/data/recap-music`). It contains four mood subfolders:

```
recap-music/
├── upbeat/      # driving, cheerful    → trips, "Kürzlich" (recent) highlights
├── warm/        # warm, heartfelt      → person recaps
├── nostalgic/   # nostalgic, calm      → "Heute vor X Jahren" (X years ago today)
└── calm/        # calm, atmospheric    → places, topics
```

Just drop files in — nothing else to do:

- Supported formats: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`
  (MP3 or M4A recommended; web and iOS play these without special cases).
- The track title is derived from the file name:
  `01_sunny-road.mp3` → "Sunny Road" (leading numbers are stripped).
- Hidden files (`.foo.mp3`) and non-audio files are ignored.
- Recommended: instrumental pieces 2–3 minutes long; the player loops.
  Watch for consistent loudness (normalize beforehand if needed, e.g. with
  `ffmpeg -i in.mp3 -filter:a loudnorm out.mp3`).

## How the Selection Works

- Each recap type is permanently assigned to a mood (see above).
- For each recap, one track is chosen deterministically from the matching
  mood folder — the same recap gets the same track on every playback.
- If a mood folder is empty, the selection falls back to the whole pool.
- The player (web and iOS) fades the music in and out smoothly, ties it to
  pause/resume, and has a mute button.

## Where to Get Music (License!)

Only use music whose license allows embedding it in your own application.
Proven sources:

- **Pixabay Music** (https://pixabay.com/music/) — free, commercial use
  allowed, no attribution required. Best first stop.
- **Free Music Archive** (https://freemusicarchive.org/) — check the license
  per track; CC-BY requires attribution.
- **Incompetech / Kevin MacLeod** (https://incompetech.com/) — CC-BY.

**Not** suitable: subscription services (Epidemic Sound, Artlist — the
license expires with the subscription), YouTube Audio Library (licensed only
for YouTube videos), purchased/streamed music from iTunes/Spotify or the like.

Tip: record one line per track with source and license in a `LICENSES.txt`
in the music folder — the file is ignored and does no harm.

## API

- `GET /recaps-music` — lists all tracks (`id`, `mood`, `title`, `url`).
- `GET /recaps-music/file/<mood>/<file>` — streams a track
  (with HTTP range support for Safari/AVPlayer).
- `GET /recaps/:id` — returns the suggested track for the player in the
  `music` field.
