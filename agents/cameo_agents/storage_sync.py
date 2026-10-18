"""Durable copies of the server's runtime data in Cloud Storage, so the server can sleep (scale to zero) and be
redeployed without losing uploads, generated stills and clips, spending counters or analytics.

The API keeps working on its local disk exactly as without a bucket; this module only copies and restores:

  - every ~15 s (and once more on shutdown) files under out/ that are new or changed are uploaded to
    gs://<CAMEO_BUCKET>/<same path>; temporary files are skipped, and files that shipped in the image (the samples)
    are never uploaded;
  - on start, the small state files (spending counters, ceilings, the activity log) are downloaded before anything
    reads them;
  - an episode is restored on demand: the first request for it after a start downloads whatever of it is in the
    bucket and missing locally (a whole upload, or the stills and clips visitors made on a sample);
  - deleting an episode deletes its copy.

Off when CAMEO_BUCKET is unset (local development and tests use a folder via DirStore).
"""

from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Iterable, Optional, Protocol

INTERVAL_S = 15.0
TIMEOUT_S = 10.0  # per Cloud Storage call: a slow store never holds up a start or a request for long
EPISODE_RE = re.compile(r"^up-[0-9a-f]{8,16}$")  # only real episode ids are looked up (not every id a scanner tries)
STATE = (".limits.json", ".limits-config.json", ".ops/activity.jsonl", ".ops/salt")
SKIP_SUFFIXES = (".part", ".tmp", ".raw.mp4", ".part.mp4", ".part.jpg")


class Store(Protocol):
    def put(self, local: Path, key: str) -> None: ...
    def get(self, key: str, local: Path) -> bool: ...
    def keys(self, prefix: str) -> list[str]: ...
    def delete(self, prefix: str) -> None: ...


class GcsStore:
    def __init__(self, bucket: str):
        from google.api_core.retry import Retry
        from google.cloud import storage

        self.bucket = storage.Client().bucket(bucket)
        self.retry = Retry(initial=0.2, maximum=2.0, timeout=TIMEOUT_S)

    def put(self, local: Path, key: str) -> None:
        self.bucket.blob(key).upload_from_filename(str(local), timeout=TIMEOUT_S, retry=self.retry)

    def get(self, key: str, local: Path) -> bool:
        from google.api_core.exceptions import NotFound

        local.parent.mkdir(parents=True, exist_ok=True)
        tmp = local.with_name(local.name + ".part")
        try:
            self.bucket.blob(key).download_to_filename(str(tmp), timeout=TIMEOUT_S, retry=self.retry)
        except NotFound:
            tmp.unlink(missing_ok=True)
            return False
        tmp.replace(local)
        return True

    def keys(self, prefix: str) -> list[str]:
        return [b.name for b in self.bucket.list_blobs(prefix=prefix, timeout=TIMEOUT_S, retry=self.retry)]

    def delete(self, prefix: str) -> None:
        blobs = list(self.bucket.list_blobs(prefix=prefix, timeout=TIMEOUT_S, retry=self.retry))
        if blobs:
            self.bucket.delete_blobs(blobs)

    def sign_put(self, key: str, content_type: str, max_bytes: int, minutes: int = 15) -> tuple[str, dict]:
        """A V4 signed URL the browser PUTs one file to, no larger than max_bytes. Signed with the service account's own
        identity (IAM signBlob), so no key file exists anywhere."""
        import datetime

        import google.auth
        from google.auth.transport.requests import Request

        creds, _ = google.auth.default()
        creds.refresh(Request())
        headers = {"Content-Type": content_type, "x-goog-content-length-range": f"0,{max_bytes}"}
        url = self.bucket.blob(key).generate_signed_url(version="v4", expiration=datetime.timedelta(minutes=minutes), method="PUT",
                                                        headers=headers, service_account_email=creds.service_account_email,
                                                        access_token=creds.token)
        # the library adds Host to the dict it signed; a browser sets that itself (and refuses to be told)
        return url, {k: v for k, v in headers.items() if k.lower() != "host"}


class DirStore:
    """A folder standing in for the bucket (tests, local runs)."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def put(self, local: Path, key: str) -> None:
        dest = self.root / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(local.read_bytes())

    def get(self, key: str, local: Path) -> bool:
        src = self.root / key
        if not src.is_file():
            return False
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(src.read_bytes())
        return True

    def keys(self, prefix: str) -> list[str]:
        """Every key starting with `prefix`, as Cloud Storage lists them (a full key matches itself)."""
        if not self.root.is_dir():
            return []
        return sorted(k for k in (p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file()) if k.startswith(prefix))

    def delete(self, prefix: str) -> None:
        for k in self.keys(prefix):
            (self.root / k).unlink(missing_ok=True)


def _skip(rel: str) -> bool:
    """Temporary files, and hidden files other than the state files, are never stored."""
    if rel.endswith(SKIP_SUFFIXES):
        return True
    return any(part.startswith(".") for part in rel.split("/")) and rel not in STATE


class Sync:
    def __init__(self, root: Path, store: Optional[Store]):
        self.root, self.store = Path(root), store
        self._seen: dict[str, tuple[int, int]] = {}
        self._restored: set[str] = set()
        self._gone: set[str] = set()  # episodes deleted while this server runs: never uploaded or restored again
        self._lock = threading.Lock()
        self._episode_locks: dict[str, threading.Lock] = {}
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    @property
    def on(self) -> bool:
        return self.store is not None

    def _files(self) -> Iterable[tuple[str, Path]]:
        if not self.root.is_dir():
            return
        for p in self.root.rglob("*"):
            if p.is_file():
                rel = p.relative_to(self.root).as_posix()
                if not _skip(rel):
                    yield rel, p

    def baseline(self) -> None:
        """Everything on disk now (the image's samples, files just restored) counts as already stored."""
        for rel, p in self._files():
            st = p.stat()
            self._seen[rel] = (st.st_size, st.st_mtime_ns)

    def restore_state(self) -> None:
        """Before anything reads them: the spending counters, the ceilings and the activity log. A store that does not
        answer never stops the server starting: it starts with fresh state and keeps trying to store."""
        if not self.on:
            return
        t0 = time.monotonic()
        got = 0
        for rel in STATE:
            try:
                got += self._fetch(rel)
            except Exception as e:  # noqa: BLE001
                print(f"[storage] restore {rel} failed: {e!s:.200}", flush=True)
        print(f"[storage] state restored: {got} of {len(STATE)} files in {time.monotonic() - t0:.1f}s", flush=True)

    def _fetch(self, rel: str) -> bool:
        p = self.root / rel
        ok = self.store.get(rel, p)
        if ok:
            st = p.stat()
            self._seen[rel] = (st.st_size, st.st_mtime_ns)
        return ok

    def ensure(self, episode: str) -> None:
        """The first time an episode is asked for after a start: bring back whatever of it is stored and missing here."""
        if not self.on or episode in self._restored or episode in self._gone or not EPISODE_RE.match(episode):
            return
        with self._lock:
            lock = self._episode_locks.setdefault(episode, threading.Lock())
        with lock:
            if episode in self._restored:
                return
            try:
                for key in self.store.keys(f"{episode}/"):
                    if not (self.root / key).is_file() and not _skip(key):
                        self._fetch(key)
            except Exception as e:  # noqa: BLE001  (a store hiccup never blocks a request; the next one tries again)
                print(f"[storage] restore {episode} failed: {e!s:.200}", flush=True)
                return
            self._restored.add(episode)

    def push(self) -> int:
        """Upload files that are new or changed since they were last stored. Returns how many."""
        if not self.on:
            return 0
        n = 0
        try:
            files = list(self._files())
        except OSError as e:  # a folder removed while it was being walked: the next round sees the new state
            print(f"[storage] scan failed: {e!s:.200}", flush=True)
            return 0
        for rel, p in files:
            if rel.split("/", 1)[0] in self._gone:
                continue
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            sig = (st.st_size, st.st_mtime_ns)
            if self._seen.get(rel) == sig:
                continue
            try:
                self.store.put(p, rel)
                self._seen[rel] = sig
                n += 1
            except FileNotFoundError:
                continue
            except Exception as e:  # noqa: BLE001
                print(f"[storage] upload {rel} failed: {e!s:.200}", flush=True)
        return n

    def drop(self, episode: str, subdirs: Iterable[str]) -> None:
        """Parts of an episode were rebuilt (re-extract): their stored copies go too, so a restore never brings them back."""
        for sub in subdirs:
            prefix = f"{episode}/{sub}/"
            self._seen = {k: v for k, v in self._seen.items() if not k.startswith(prefix)}
            if self.on:
                try:
                    self.store.delete(prefix)
                except Exception as e:  # noqa: BLE001
                    print(f"[storage] drop {prefix} failed: {e!s:.200}", flush=True)

    def forget(self, episode: str) -> None:
        """An episode was deleted: drop its stored copy too."""
        self._gone.add(episode)
        self._seen = {k: v for k, v in self._seen.items() if not k.startswith(f"{episode}/")}
        if self.on:
            try:
                self.store.delete(f"{episode}/")
            except Exception as e:  # noqa: BLE001
                print(f"[storage] delete {episode} failed: {e!s:.200}", flush=True)

    def start(self) -> None:
        if not self.on or self._thread:
            return

        def loop() -> None:
            while not self._stop.wait(INTERVAL_S):
                try:
                    self.push()
                except Exception as e:  # noqa: BLE001  (the loop outlives any one bad round)
                    print(f"[storage] sync round failed: {e!s:.200}", flush=True)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Shutdown: one last upload (Cloud Run allows about 10 s)."""
        self._stop.set()
        t0 = time.monotonic()
        n = self.push()
        if self.on:
            print(f"[storage] final sync: {n} files in {time.monotonic() - t0:.1f}s", flush=True)


def from_env(root: Path) -> Sync:
    bucket = os.environ.get("CAMEO_BUCKET", "").strip()
    return Sync(root, GcsStore(bucket) if bucket else None)
