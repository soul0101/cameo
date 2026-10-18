"""Stage 0: ingest (ffmpeg only, no AI).

    python -m cameo_agents.ingest <video> <out_dir> [--threshold 0.3]

Produces in <out_dir>: proxy_360p.mp4, audio.m4a, keyframes/<shot>_<pos>.jpg (720 wide), ingest.json.
Shots are real cuts only (ffmpeg scene score > threshold): a continuous take stays one shot whatever its length.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

from .schemas import IngestResult, Keyframe, Shot, ShotDetection

MIN_GAP = 0.5  # cuts closer than this to each other or to the ends are dropped


class FFmpegError(RuntimeError):
    pass


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise FFmpegError(f"{cmd[0]} failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr[-2000:]}")
    return p


def trim_video(video: Path, seconds: float) -> Path:
    """Keep the first `seconds` of an upload (re-encoded, so the cut is frame-accurate); replaces the source file."""
    video = Path(video)
    tmp = video.with_name(f"trimmed{video.suffix or '.mp4'}")
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-t", f"{seconds:.3f}", "-c:v", "libx264", "-preset", "veryfast",
          "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp)])
    dest = video.with_suffix(".mp4")
    video.unlink()
    tmp.replace(dest)
    return dest


def probe(video: Path) -> dict:
    p = _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(video)])
    info = json.loads(p.stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "25/1").split("/")
    return {
        "duration": float(info["format"]["duration"]),
        "width": int(v["width"]),
        "height": int(v["height"]),
        "fps": float(num) / float(den or 1) if float(den or 1) else 25.0,
        "audio_codec": a["codec_name"] if a else None,
    }


def detect_cuts(video: Path, threshold: float = 0.3) -> list[float]:
    """Cut times (s) where ffmpeg's scene score exceeds `threshold`."""
    p = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(video), "-an", "-filter:v", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"])
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", p.stderr)]


def clean_cuts(cuts: list[float], duration: float) -> list[float]:
    out: list[float] = []
    for c in sorted(cuts):
        if c < MIN_GAP or c > duration - MIN_GAP:
            continue
        if out and c - out[-1] < MIN_GAP:
            continue
        out.append(round(c, 3))
    return out


def shots_from_cuts(cuts: list[float], duration: float) -> list[Shot]:
    bounds = [0.0, *cuts, round(duration, 3)]
    return [Shot(shotId=f"C{i + 1:02d}", index=i, tIn=bounds[i], tOut=bounds[i + 1]) for i in range(len(bounds) - 1)]


def keyframe_times(shot: Shot, positions: tuple[str, ...] = ("start", "mid", "end")) -> list[tuple[str, float]]:
    d = shot.duration
    pad = min(0.25, d * 0.05)
    at = {
        "start": shot.tIn + pad,
        "q1": shot.tIn + d * 0.25,
        "mid": shot.tIn + d / 2,
        "q3": shot.tIn + d * 0.75,
        "end": shot.tOut - pad,
    }
    return [(p, round(at[p], 3)) for p in positions]


def extract_frame(video: Path, t: float, dest: Path, width: int = 720) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(dest)])


def make_proxy(video: Path, dest: Path) -> None:
    # Short side 360 (portrait 1080x1920 -> 360x640), H.264 + AAC so Gemini also hears the dialogue.
    vf = "scale='if(gt(iw,ih),-2,360)':'if(gt(iw,ih),360,-2)'"
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(dest)])


def extract_audio(video: Path, dest: Path, codec: str | None) -> bool:
    if codec is None:
        return False
    acodec = ["-c:a", "copy"] if codec == "aac" else ["-c:a", "aac", "-b:a", "128k"]
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-vn", *acodec, str(dest)])
    return True


def ingest(video: str | Path, out_dir: str | Path, threshold: float = 0.3, workers: int = 8,
           on_progress: Callable[[str, float], None] | None = None, episode_id: str | None = None) -> IngestResult:
    """on_progress(message, fraction 0..1) is optional and called from the calling thread; episode_id defaults to the file stem."""
    note = on_progress or (lambda msg, frac: None)
    video, out = Path(video).resolve(), Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    meta = probe(video)
    duration = meta["duration"]
    note(f"Probed {duration:.1f}s {meta['width']}x{meta['height']}", 0.05)

    # The proxy and the audio do not depend on the cuts: encode them while the cut detector reads the video.
    ex = ThreadPoolExecutor(max_workers=workers)
    fut_proxy = ex.submit(make_proxy, video, out / "proxy_360p.mp4")
    fut_audio = ex.submit(extract_audio, video, out / "audio.m4a", meta["audio_codec"])

    cuts = clean_cuts(detect_cuts(video, threshold), duration)
    detection = ShotDetection(method="scene", threshold=threshold, cuts=cuts)
    detection_scene_cuts = cuts
    shots = shots_from_cuts(detection.cuts, duration)
    note(f"{len(shots)} shots", 0.2)

    jobs: list[tuple[Shot, str, float, Path]] = []
    for s in shots:
        for pos, t in keyframe_times(s):
            rel = f"keyframes/{s.shotId}_{pos}.jpg"
            s.keyframes.append(Keyframe(shotId=s.shotId, pos=pos, t=t, path=rel))  # type: ignore[arg-type]
            jobs.append((s, pos, t, out / rel))

    with ex:
        frames = [ex.submit(extract_frame, video, t, dest) for _, _, t, dest in jobs]
        fut_proxy.result()
        note("360p proxy ready", 0.5)
        has_audio = fut_audio.result()
        for i, f in enumerate(frames, start=1):
            f.result()
            if i % 5 == 0 or i == len(frames):
                note(f"{jobs[i - 1][0].shotId} · {i}/{len(frames)} keyframes", 0.5 + 0.5 * i / len(frames))

    result = IngestResult(
        episodeId=episode_id or video.stem,
        video=str(video),
        duration=round(duration, 3),
        width=meta["width"],
        height=meta["height"],
        fps=round(meta["fps"], 3),
        proxy="proxy_360p.mp4",
        audio="audio.m4a" if has_audio else None,
        detection=detection,
        shots=shots,
    )
    data = result.model_dump()
    data["detection"]["sceneCutsRaw"] = detection_scene_cuts
    (out / "ingest.json").write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return result


def load_ingest(out_dir: str | Path) -> IngestResult:
    return IngestResult.model_validate_json((Path(out_dir) / "ingest.json").read_text())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m cameo_agents.ingest", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("out_dir")
    ap.add_argument("--threshold", type=float, default=0.3)
    a = ap.parse_args(argv)
    r = ingest(a.video, a.out_dir, a.threshold)
    print(f"{r.episodeId}: {r.duration:.2f}s {r.width}x{r.height} @ {r.fps}fps")
    print(f"detection: {r.detection.method} (threshold {r.detection.threshold}), {len(r.detection.cuts)} cuts: {r.detection.cuts}")
    for s in r.shots:
        print(f"  {s.shotId}  {s.tIn:7.3f} -> {s.tOut:7.3f}  ({s.duration:.2f}s)")
    print(f"wrote {Path(a.out_dir) / 'ingest.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
