"""Durable copies in a store (a folder standing in for Cloud Storage): upload, restore on start and on demand, delete."""
import shutil

from cameo_agents.storage_sync import DirStore, Sync


def make(root):
    (root / "up-5a5a5a5a").mkdir(parents=True)
    (root / "up-5a5a5a5a" / "sample.json").write_text("{}")  # shipped in the image
    return root


def test_push_restore_and_forget(tmp_path):
    store = DirStore(tmp_path / "bucket")
    root = make(tmp_path / "a")
    s = Sync(root, store)
    s.baseline()
    (root / "up-12340000" / "renders").mkdir(parents=True)
    (root / "up-12340000" / "ingest.json").write_text("{}")
    (root / "up-12340000" / "renders" / "r.mp4").write_bytes(b"clip")
    (root / "up-12340000" / "renders" / "r.part.mp4").write_bytes(b"half")  # temporary: never stored
    (root / "up-5a5a5a5a" / "previews").mkdir()
    (root / "up-5a5a5a5a" / "previews" / "p.png").write_bytes(b"still")  # made by a visitor on a sample
    (root / ".ops").mkdir()
    (root / ".ops" / "activity.jsonl").write_text("{}\n")
    (root / ".limits.json").write_text('{"spent": 1}')
    (root / ".DS_Store").write_text("x")
    assert s.push() == 5 and s.push() == 0  # unchanged files are not sent again
    assert set(store.keys("")) == {"up-12340000/ingest.json", "up-12340000/renders/r.mp4", "up-5a5a5a5a/previews/p.png", ".ops/activity.jsonl", ".limits.json"}
    (root / ".limits.json").write_text('{"spent": 2}')
    assert s.push() == 1

    # a fresh server (scaled to zero, or redeployed): only the image's samples are on disk
    root2 = make(tmp_path / "b")
    s2 = Sync(root2, store)
    s2.restore_state()
    s2.baseline()
    assert (root2 / ".limits.json").read_text() == '{"spent": 2}' and (root2 / ".ops" / "activity.jsonl").is_file()
    assert not (root2 / "up-12340000").exists()
    s2.ensure("up-12340000")
    assert (root2 / "up-12340000" / "renders" / "r.mp4").read_bytes() == b"clip" and not (root2 / "up-12340000" / "renders" / "r.part.mp4").exists()
    s2.ensure("up-5a5a5a5a")
    assert (root2 / "up-5a5a5a5a" / "previews" / "p.png").read_bytes() == b"still"
    assert s2.push() == 0  # restored files are not sent back

    s2.drop("up-12340000", ["renders"])
    assert store.keys("up-12340000/") == ["up-12340000/ingest.json"]
    shutil.rmtree(root2 / "up-12340000")  # DELETE /episodes/{id} removes the folder, then forgets the stored copy
    s2.forget("up-12340000")
    assert store.keys("up-12340000/") == []
    (root2 / "up-12340000").mkdir()
    (root2 / "up-12340000" / "late.json").write_text("{}")  # written by work still finishing as it was deleted
    s2.push()
    assert store.keys("up-12340000/") == []  # a deleted episode is never stored again
    s2.ensure("up-12340000")
    assert not (root2 / "up-12340000" / "ingest.json").exists()


def test_store_failures_never_stop_the_server(tmp_path):
    class Broken:
        def put(self, *a): raise OSError("store down")
        def get(self, *a): raise OSError("store down")
        def keys(self, *a): raise OSError("store down")
        def delete(self, *a): raise OSError("store down")

    root = make(tmp_path)
    s = Sync(root, Broken())
    s.restore_state()  # starts anyway
    s.baseline()
    (root / "up-abcd1234").mkdir()
    (root / "up-abcd1234" / "ingest.json").write_text("{}")
    assert s.push() == 0  # failed uploads are retried next round
    s.ensure("up-abcd1234")
    s.forget("up-abcd1234")


def test_only_real_episode_ids_are_looked_up(tmp_path):
    calls = []

    class Counting(DirStore):
        def keys(self, prefix):
            calls.append(prefix)
            return super().keys(prefix)

    s = Sync(make(tmp_path / "r"), Counting(tmp_path / "bucket"))
    for eid in ("../etc", "nope", "up-zzzz", "second-cup", "up-1234abcd", "up-1234abcd"):
        s.ensure(eid)
    assert calls == ["up-1234abcd/"]  # once, and only for a real-looking id


def test_off_without_a_store(tmp_path):
    s = Sync(make(tmp_path), None)
    s.restore_state()
    s.ensure("up-x")
    assert s.push() == 0 and not s.on
