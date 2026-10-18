"""Typed JSON for every detection stage, plus the web-app export.

Stage 0  Ingest            -> IngestResult (Shot[])
Stage 1  Scene understanding -> SceneUnderstanding[] (one per shot)
Stage 2  Localisation      -> Box[] (with mask ref and per-frame track)
Stage 3  Matching          -> Suggestion[] (per box per region) + default prompts
Final                      -> ScenesPageOutput (scenes.json) and to_web_json() (web.json)

All boxes inside the pipeline are normalised 0-1 {x, y, w, h} (top-left origin). Gemini's
`box_2d` ([ymin, xmin, ymax, xmax] on 0-1000) is converted at the model boundary
(`NormBox.from_box_2d`).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------- shared


class _M(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class NormBox(_M):
    """Normalised box, 0-1, top-left origin (the web app's `Box`)."""

    x: float
    y: float
    w: float
    h: float

    @classmethod
    def from_box_2d(cls, b: list[float]) -> "NormBox":
        """Gemini `box_2d` = [ymin, xmin, ymax, xmax] on 0-1000 -> normalised x/y/w/h."""
        ymin, xmin, ymax, xmax = (max(0.0, min(1000.0, float(v))) / 1000.0 for v in b)
        if xmax < xmin:
            xmin, xmax = xmax, xmin
        if ymax < ymin:
            ymin, ymax = ymax, ymin
        return cls(x=xmin, y=ymin, w=xmax - xmin, h=ymax - ymin)

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)

    def iou(self, o: "NormBox") -> float:
        ix = max(0.0, min(self.x + self.w, o.x + o.w) - max(self.x, o.x))
        iy = max(0.0, min(self.y + self.h, o.y + o.h) - max(self.y, o.y))
        inter = ix * iy
        union = self.area + o.area - inter
        return inter / union if union > 0 else 0.0

    def intersection(self, o: "NormBox") -> float:
        ix = max(0.0, min(self.x + self.w, o.x + o.w) - max(self.x, o.x))
        iy = max(0.0, min(self.y + self.h, o.y + o.h) - max(self.y, o.y))
        return ix * iy

    def distance(self, o: "NormBox") -> float:
        """Edge-to-edge distance (0 when touching or overlapping)."""
        dx = max(0.0, max(o.x - (self.x + self.w), self.x - (o.x + o.w)))
        dy = max(0.0, max(o.y - (self.y + self.h), self.y - (o.y + o.h)))
        return (dx * dx + dy * dy) ** 0.5

    def lerp(self, o: "NormBox", a: float) -> "NormBox":
        return NormBox(x=self.x + (o.x - self.x) * a, y=self.y + (o.y - self.y) * a, w=self.w + (o.w - self.w) * a, h=self.h + (o.h - self.h) * a)

    def rounded(self, nd: int = 3) -> "NormBox":
        return NormBox(x=round(self.x, nd), y=round(self.y, nd), w=round(self.w, nd), h=round(self.h, nd))


# ---------------------------------------------------------------- stage 0: ingest

KeyframePos = Literal["start", "q1", "mid", "q3", "end"]


class Keyframe(_M):
    shotId: str
    pos: KeyframePos
    t: float
    path: str  # relative to the ingest out_dir


class Shot(_M):
    shotId: str
    index: int
    tIn: float
    tOut: float
    keyframes: list[Keyframe] = Field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.tOut - self.tIn


class ShotDetection(_M):
    method: Literal["scene"] = "scene"
    threshold: float
    cuts: list[float]


class IngestResult(_M):
    episodeId: str
    video: str
    duration: float
    width: int
    height: int
    fps: float
    proxy: str
    audio: Optional[str] = None
    detection: ShotDetection
    shots: list[Shot]


# ---------------------------------------------------------------- stage 1: scene understanding

SurfaceKind = Literal["table", "wall", "sign", "screen", "shelf", "hand", "counter", "vehicle", "apparel"]
SensitivityLevel = Literal["none", "low", "medium", "high", "critical"]
CameraMotion = Literal["static", "pan", "tilt", "dolly", "handheld", "zoom"]


class SceneInfo(_M):
    type: str  # e.g. "café", "street", "apartment", "shop"
    mood: str
    tags: list[str] = Field(default_factory=list)


class People(_M):
    count: int = 0
    facesVisible: int = 0


class Sensitivity(_M):
    level: SensitivityLevel = "none"
    reasons: list[str] = Field(default_factory=list)


class Surface(_M):
    """A candidate surface named in words by stage 1 (no pixels yet)."""

    label: str
    kind: SurfaceKind
    timeVisible: float = Field(description="seconds the surface is visible in the shot")
    nearFace: bool = False
    hasText: bool = False


# Fixed rule in every prompt that places a product (Gemini's match and identify prompts, Nano Banana's still,
# Gemini Omni's render). The producer's editable prompt never carries it, so it cannot be edited away.
VISIBILITY_RULE = (
    "Put each product where the camera sees it clearly, its front and brand facing the camera, in the most natural "
    "spot the scene allows: a bag hangs over a chair's back or arm rather than lying on the seat, a pack stands "
    "upright facing the lens, a poster stays unobstructed. Never hide it behind people or objects, and never pose "
    "it unnaturally just to show it."
)


# Fixed rule beside VISIBILITY_RULE: when a person uses the object a product replaces, the use follows the product.
INTERACTION_RULE = (
    "When someone is using the object a product replaces, the use follows the new product: whatever they eat, drink, "
    "hold or touch comes from it and matches it (snacks from a new pack are that pack's snack, a sip comes from the new "
    "can). Their pose, gesture and timing stay the same; only what the swap requires changes."
)


class Setup(_M):
    """A stretch of one shot with one camera setup (a shot can hold several when the camera moves or the
    content changes without a cut). Render segments are planned from these."""
    tIn: float
    tOut: float
    angle: str = ""  # camera setup label, shared by every stretch filmed from the same angle (A-B-A-B editing)
    spots: list[str] = Field(default_factory=list)  # surface labels visible in this stretch
    motion: Literal["low", "medium", "high"] = "low"


class SceneUnderstanding(_M):
    shotId: str
    tIn: float
    tOut: float
    scene: SceneInfo
    people: People = Field(default_factory=People)
    cameraMotion: CameraMotion = "static"
    sensitivity: Sensitivity = Field(default_factory=Sensitivity)
    surfaces: list[Surface] = Field(default_factory=list)
    dialogueCues: list[str] = Field(default_factory=list)
    # Grouping for rendering: shots of the same place and moment share `sceneGroup`; each shot's camera setups.
    sceneGroup: str = ""
    setups: list[Setup] = Field(default_factory=list)


SENSITIVITY_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


DISTRESS_WORDS = (
    "grief", "grieving", "bad news", "sad", "sadness", "disappointed", "disappointment", "upset", "crying", "tearful",
    "distress", "distressed", "mourning", "heartbroken", "devastated", "anxious", "anxiety", "despair", "funeral", "loss",
)


def is_skipped(s: SceneUnderstanding) -> bool:
    """A scene is skipped when sensitivity >= high, or when the mood/reasons describe emotional distress
    (the model often rates "pensive, disappointed" as sensitivity none; the product rule is stricter than the model)."""
    if SENSITIVITY_ORDER[s.sensitivity.level] >= SENSITIVITY_ORDER["high"]:
        return True
    words = " ".join([s.scene.mood, *s.scene.tags, *s.sensitivity.reasons]).lower()
    return any(w in words for w in DISTRESS_WORDS)


# ---------------------------------------------------------------- stage 2: localisation


class TrackPoint(_M):
    t: float
    box: NormBox


class Box(_M):
    """A localised surface. `box` is the representative (mid-shot) box; `track` the per-frame boxes."""

    id: str = ""
    shotId: str = ""
    label: str
    kind: SurfaceKind | Literal["face"]
    box: NormBox
    t: float = 0.0  # time of the frame this box was read from (master seconds)
    track: list[TrackPoint] = Field(default_factory=list)
    maskRef: Optional[str] = None  # path (relative to out_dir) of a JSON polygon, 0-1 normalised [[x, y], ...]
    occludedByHands: float = 0.0  # 0-1
    nearFace: Optional[float] = None  # edge distance to nearest face box (normalised); None = no faces
    textPresent: bool = False
    areaPct: float = 0.0
    salience: Optional[float] = None  # 0-1, model's guess of viewer attention
    shotIds: list[str] = Field(default_factory=list)  # filled when a box is merged across shots
    blocked: bool = False


class LocalisedFrame(_M):
    """What `LLM.localise` returns for one keyframe: surface boxes plus face boxes (kind="face")."""

    boxes: list[Box]
    masks: dict[str, list[list[float]]] = Field(default_factory=dict)  # label -> polygon (0-1)


# ---------------------------------------------------------------- stage 3: matching


class ProductSuggestion(_M):
    productId: str
    fit: float = Field(ge=0, le=1)
    why: str


class Suggestion(_M):
    boxId: str
    region: str
    suggestions: list[ProductSuggestion]
    defaultPrompt: str


class SceneRerank(_M):
    """One re-rank call per scene: suggestions for all its boxes and regions."""

    shotId: str
    boxNotes: dict[str, str] = Field(default_factory=dict)  # boxId -> one-line reasoning about the surface
    suggestions: list[Suggestion]


class RuleSet(_M):
    exclusions: dict[str, list[str]] = Field(default_factory=dict)  # brand line -> scene words to avoid
    noCompetitorsInScene: bool = True
    noAlcoholNearMinors: bool = True
    productOnlyEdits: bool = True


class Product(_M):
    id: str  # e.g. "brewno-IN"
    line: str  # brand id shared across regions, e.g. "brewno"
    region: str
    brand: str
    name: str
    category: str
    fits: list[str] = Field(default_factory=list)
    affinity: list[str] = Field(default_factory=list)
    exclusions: list[str] = Field(default_factory=list)

    def embed_text(self) -> str:
        return f"{self.brand} · {self.name} · {self.category} · {self.region} · fits: [{', '.join(self.fits)}] · scenes: [{', '.join(self.affinity)}]"


# ---------------------------------------------------------------- final


class SkippedScene(_M):
    shotId: str
    tIn: float
    tOut: float
    reasons: list[str]


class ScenesPageOutput(_M):
    episodeId: str
    regions: list[str]
    scenes: list[SceneUnderstanding]
    boxes: list[Box]
    suggestions: dict[str, list[Suggestion]]  # region -> suggestions
    prompts: dict[str, dict[str, str]]  # region -> boxId -> default prompt
    skipped: list[SkippedScene]
    boxNotes: dict[str, str] = Field(default_factory=dict)
    keyframes: dict[str, str] = Field(default_factory=dict)  # shotId -> mid keyframe path
    llm: str = "mock"


# ---------------------------------------------------------------- web export

WEB_SURFACE = {
    "table": "table",
    "wall": "wall",
    "sign": "street",
    "vehicle": "street",
    "screen": "screen",
    "hand": "hand",
    "counter": "counter",
    "shelf": "counter",
    "apparel": "wardrobe",
}

RULE_LABELS = [
    ("minors", "No minors"),
    ("claims", "No health claims"),
    ("competitor", "No competitor"),
    ("tone", "Scene tone OK"),
    ("product-only", "Product-only edit"),
]


def web_scene(scene_type: str) -> str:
    t = scene_type.lower()
    if any(k in t for k in ("café", "cafe", "coffee", "restaurant")):
        return "Café"
    if any(k in t for k in ("street", "road", "bus", "outdoor", "city")):
        return "Street"
    if any(k in t for k in ("shop", "store", "counter", "market", "supermarket")):
        return "Shop"
    return "Apartment"


def _risks(b: Box, scene: SceneUnderstanding, skipped: bool) -> list[str]:
    r: list[str] = []
    if skipped:
        r.append("sensitive")
    if b.nearFace is not None and b.nearFace < 0.08:
        r.append("face near")
    if b.occludedByHands > 0:
        r.append("hands")
    if b.textPresent:
        r.append("text")
    if scene.cameraMotion != "static":
        r.append("motion")
    return r


def _chip_anchor(b: NormBox) -> dict[str, float]:
    x = b.x + b.w + 0.02 if b.x + b.w < 0.8 else max(0.05, b.x - 0.04)
    y = min(0.95, max(0.05, b.y + b.h * 0.4))
    return {"x": round(x, 3), "y": round(y, 3)}


def to_web_json(out: ScenesPageOutput, media_prefix: str = "", primary_region: Optional[str] = None) -> dict:
    """Emit `{ moments, placements }`: the scenes, boxes and per-audience picks that detected.json serves the web app.

    One moment per group of boxes that share the same shot span; its `box` is the best-fitting box,
    and every non-blocked box with a product becomes a placement (P1...).
    Moments are ordered by (tIn, -suitability) and numbered M1...
    """
    regions = out.regions
    region0 = primary_region or (regions[0] if regions else "")
    scene_by_shot = {s.shotId: s for s in out.scenes}
    skipped_ids = {s.shotId for s in out.skipped}
    top: dict[str, ProductSuggestion] = {}
    per_box_regions: dict[str, list[str]] = {}
    product_line: dict[str, str] = {}
    for region, sugs in out.suggestions.items():
        for s in sugs:
            if s.suggestions:
                per_box_regions.setdefault(s.boxId, []).append(region)
                best = max(s.suggestions, key=lambda p: p.fit)
                if region == region0 or s.boxId not in top:
                    top[s.boxId] = best
    for sugs in out.suggestions.values():
        for s in sugs:
            for p in s.suggestions:
                product_line[p.productId] = p.productId.rsplit("-", 1)[0]

    surface_boxes = [b for b in out.boxes if b.kind != "face"]
    groups: dict[tuple[str, ...], list[Box]] = {}
    for b in surface_boxes:
        groups.setdefault(tuple(b.shotIds or [b.shotId]), []).append(b)

    def fit_of(b: Box) -> float:
        return top[b.id].fit if b.id in top else 0.0

    def suitability(group: list[Box]) -> int:
        if any(b.blocked for b in group):
            return 0
        return round(max(fit_of(b) for b in group) * 100)

    def t_range(shot_ids: tuple[str, ...]) -> tuple[float, float]:
        sc = [scene_by_shot[s] for s in shot_ids if s in scene_by_shot]
        return (min(s.tIn for s in sc), max(s.tOut for s in sc)) if sc else (0.0, 0.0)

    ordered = sorted(groups.items(), key=lambda kv: (t_range(kv[0])[0], -suitability(kv[1]), kv[0]))
    moments: list[dict] = []
    placements: list[dict] = []
    for i, (shot_ids, group) in enumerate(ordered, start=1):
        mid = f"M{i}"
        group = sorted(group, key=lambda b: (-fit_of(b), -b.box.area))
        primary = group[0]
        primary_shot = primary.shotId
        scene = scene_by_shot[primary_shot]
        skipped = primary_shot in skipped_ids or primary.blocked
        tin, tout = t_range(shot_ids)
        brand = None if (skipped or primary.id not in top) else product_line.get(top[primary.id].productId)
        mode = "blocked" if skipped else ("insert" if primary.kind == "wall" else "replace")
        moment = {
            "id": mid,
            "shotId": primary_shot,
            "shotIds": list(shot_ids),
            "tIn": tin,
            "tOut": tout,
            "label": primary.label,
            "scene": web_scene(scene.scene.type),
            "surface": WEB_SURFACE.get(primary.kind, "table"),
            "mode": mode,
            "box": primary.box.rounded().model_dump(),
            "suitability": suitability(group),
            "attention": round((primary.salience if primary.salience is not None else min(1.0, 0.3 + primary.areaPct / 20)) * 100),
            "tags": [scene.scene.type, scene.scene.mood, *scene.scene.tags][:5],
            "risks": _risks(primary, scene, skipped),
            "reasoning": out.boxNotes.get(primary.id) or "; ".join(scene.sensitivity.reasons) or primary.label,
            "brandId": brand,
            "markets": [] if skipped else per_box_regions.get(primary.id, []),
            "keyframe": media_prefix + out.keyframes.get(primary_shot, ""),
            "keyframeT": round((scene.tIn + scene.tOut) / 2, 2),
        }
        moments.append(moment)
        if skipped:
            continue
        for b in group:
            if b.blocked or b.id not in top:
                continue
            placements.append(
                {
                    "id": f"P{len(placements) + 1}",
                    "momentId": mid,
                    "boxId": b.id,
                    "brandId": product_line.get(top[b.id].productId),
                    "productId": top[b.id].productId,
                    "object": b.label,
                    "box": b.box.rounded().model_dump(),
                    "chipAnchor": _chip_anchor(b.box),
                    "tIn": tin,
                    "tOut": tout,
                    "why": top[b.id].why,
                    "prompts": {r: out.prompts.get(r, {}).get(b.id, "") for r in regions if b.id in out.prompts.get(r, {})},
                    "rules": [{"id": rid, "label": lbl, "passed": True} for rid, lbl in RULE_LABELS],
                }
            )
    # stage 3 per box per region, best first (the Scenes page's "Suggested: ..." row, why line and default prompt)
    box_sugs: dict[str, dict[str, list[dict]]] = {}
    for region, sugs in out.suggestions.items():
        for s in sugs:
            box_sugs.setdefault(s.boxId, {})[region] = [{"productId": p.productId, "why": p.why} for p in s.suggestions]
    box_prompts: dict[str, dict[str, str]] = {}
    for region, by_box in out.prompts.items():
        for box_id, text in by_box.items():
            if text:
                box_prompts.setdefault(box_id, {})[region] = text
    return {"episodeId": out.episodeId, "llm": out.llm, "moments": moments, "placements": placements, "suggestions": box_sugs, "defaultPrompts": box_prompts}
