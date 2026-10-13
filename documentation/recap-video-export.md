# Recap Video Export

Recaps can be exported as MP4 ("Video" button in the detail view of the web
app): 1080p, H.264 + AAC, Ken Burns zoom per slide, crossfades, and the
recap's background music (if tracks are present in the music folder, see
`documentation/recap-music.md`).

## Prerequisite: ffmpeg

The export needs an `ffmpeg` binary on the server — it is **not** an npm
dependency. It is already included in the production image: the runtime image
(`docker/Dockerfile.runtime`) installs `ffmpeg` via apt together with the
other system tools. So there is nothing more to do.

For local development outside the container, `ffmpeg` has to be installed
once:

```bash
apt-get install ffmpeg      # Debian/Ubuntu
brew install ffmpeg         # macOS
```

The path is configurable via `FFMPEG_PATH` (default: `ffmpeg` in `PATH`).
If the binary is missing, `POST /recaps/:id/export` responds with
`failed_precondition` and a clear message; the rest of the recap
functionality is unaffected.

## Flow

1. `POST /recaps/:id/export` starts the render job (idempotent: if a job is
   already running for this recap, its state is returned; if the finished MP4
   exists in the cache, `done` is returned immediately).
2. Frames: each photo is EXIF-rotated with sharp and cropped to 16:9 around
   the `auto_crop` focus point (same smart cropping as in the player) — this
   also takes care of HEIC, since ffmpeg only sees JPEGs.
3. ffmpeg renders: `zoompan` (zoom in/out alternating, deterministic per
   photo), `xfade` transitions (3.5 s per slide, 0.6 s crossfade), music
   looped with fade-in/fade-out, `libx264 crf 20`, `faststart`.
4. `GET /recaps/:id/export/status` returns `{ status, progress,
   download_url }`; the frontend polls every 2 s and starts the download
   automatically.
5. Download via `GET /recaps-export/file/<name>.mp4`
   (Content-Disposition: attachment).

## Cache & Storage Location

Finished videos are stored under `RECAPS_EXPORT_DIR`
(default `/mnt/data/recap-exports`). The file name contains a hash over
photo set + title:

- if the recap changes (rebuild with different photos), a new file is
  created on the next export;
- unchanged recaps are served without re-encoding;
- the URL cannot be guessed without knowing the content (same level of
  protection as `/photos/file/*`).

Old exports are currently not deleted automatically — if space runs short,
the directory can be emptied safely.

## Limits

- Max. 30 photos per export (matches the recap upper limit), ~90 s of video.
- Encoding runs on the host's CPU; depending on the hardware, a full recap
  takes one to a few minutes. The job runs asynchronously; a server restart
  discards running jobs (the status endpoint does find finished files again
  after a restart, though).
- The map intro and the "Damals & heute" (then & now) slide are (not yet)
  included in the export — only the photos.
