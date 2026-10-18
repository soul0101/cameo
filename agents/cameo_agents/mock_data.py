"""Fixed scene, box and pick data for MockLLM (offline tests and keyless runs).

Indexed by shot position (0-9, 8 s each), so it works with whatever shot ids ingest produced.
Boxes are normalised {x, y, w, h}. Faces are rough hand estimates used by the face-distance guard.
"""

from __future__ import annotations

# shot index -> stage-1 understanding (minus shotId / times)
SCENES: list[dict] = [
    dict(scene=dict(type="café", mood="warm, playful", tags=["morning", "wide", "warm light"]), people=dict(count=2, facesVisible=2), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=["Same order as always?"],
         surfaces=[dict(label="Blank café wall", kind="wall", timeVisible=8), dict(label="Cups on the table", kind="table", timeVisible=8)]),
    dict(scene=dict(type="café", mood="warm", tags=["morning", "close-up", "warm light"]), people=dict(count=1, facesVisible=1), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=["You have to try this."],
         surfaces=[dict(label="Cups on the table", kind="table", timeVisible=8)]),
    dict(scene=dict(type="café", mood="relaxed", tags=["medium shot", "wardrobe"]), people=dict(count=1, facesVisible=1), cameraMotion="handheld",
         sensitivity=dict(level="none"), dialogueCues=[],
         surfaces=[dict(label="Tee and cap", kind="apparel", timeVisible=8, nearFace=True)]),
    dict(scene=dict(type="café", mood="sad", tags=["emotional beat", "close-up"]), people=dict(count=1, facesVisible=1), cameraMotion="static",
         sensitivity=dict(level="high", reasons=["Her smile fades as she reads bad news. No product belongs in this moment."]), dialogueCues=[],
         surfaces=[dict(label="Phone in hand", kind="hand", timeVisible=8, nearFace=True)]),
    dict(scene=dict(type="street", mood="calm", tags=["dusk", "wide", "static billboard"]), people=dict(count=1, facesVisible=0), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=[],
         surfaces=[dict(label="Street billboard", kind="sign", timeVisible=8)]),
    dict(scene=dict(type="street", mood="tired", tags=["dusk", "lit panel"]), people=dict(count=1, facesVisible=1), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=[],
         surfaces=[dict(label="Bus shelter panel", kind="sign", timeVisible=8)]),
    dict(scene=dict(type="apartment", mood="busy", tags=["night", "over-shoulder", "screen"]), people=dict(count=1, facesVisible=0), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=["Dinner's going to be late again."],
         surfaces=[dict(label="Laptop screen", kind="screen", timeVisible=8)]),
    dict(scene=dict(type="apartment", mood="relieved", tags=["doorway", "night", "hero prop"]), people=dict(count=2, facesVisible=1), cameraMotion="handheld",
         sensitivity=dict(level="none"), dialogueCues=["Finally."],
         surfaces=[dict(label="Delivery bag", kind="hand", timeVisible=6)]),
    dict(scene=dict(type="shop", mood="casual", tags=["night", "cold light", "shelves"]), people=dict(count=1, facesVisible=1), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=[],
         surfaces=[dict(label="Fridge shelves", kind="shelf", timeVisible=8, hasText=True)]),
    dict(scene=dict(type="shop", mood="casual", tags=["counter", "payment", "static"]), people=dict(count=1, facesVisible=1), cameraMotion="static",
         sensitivity=dict(level="none"), dialogueCues=["Yeah, I'm getting two."],
         surfaces=[dict(label="Counter standee and cans", kind="counter", timeVisible=8, nearFace=True), dict(label="Two cans", kind="counter", timeVisible=8)]),
]

# shot index -> {label: box/extra}; "faces" lists face boxes
BOXES: list[dict] = [
    {"faces": [dict(x=0.18, y=0.36, w=0.14, h=0.09), dict(x=0.62, y=0.38, w=0.13, h=0.08)],
     "Blank café wall": dict(box=dict(x=0.36, y=0.06, w=0.56, h=0.28), salience=0.46),
     "Cups on the table": dict(box=dict(x=0.39, y=0.73, w=0.2, h=0.14), salience=0.6, occludedByHands=0.1)},
    {"faces": [dict(x=0.4, y=0.2, w=0.22, h=0.14)],
     "Cups on the table": dict(box=dict(x=0.38, y=0.72, w=0.22, h=0.15), salience=0.88, occludedByHands=0.1)},
    {"faces": [dict(x=0.38, y=0.3, w=0.24, h=0.2)],
     "Tee and cap": dict(box=dict(x=0.32, y=0.55, w=0.52, h=0.25), salience=0.71)},
    {"faces": [dict(x=0.3, y=0.4, w=0.25, h=0.16)],
     "Phone in hand": dict(box=dict(x=0.18, y=0.63, w=0.22, h=0.11), salience=0.92, occludedByHands=0.3)},
    {"faces": [],
     "Street billboard": dict(box=dict(x=0.0, y=0.0, w=0.72, h=0.38), salience=0.64)},
    {"faces": [dict(x=0.45, y=0.3, w=0.1, h=0.06)],
     "Bus shelter panel": dict(box=dict(x=0.8, y=0.43, w=0.19, h=0.4), salience=0.52)},
    {"faces": [],
     "Laptop screen": dict(box=dict(x=0.44, y=0.5, w=0.45, h=0.2), salience=0.83, textPresent=True)},
    {"faces": [dict(x=0.4, y=0.2, w=0.2, h=0.12)],
     "Delivery bag": dict(box=dict(x=0.42, y=0.52, w=0.32, h=0.21), salience=0.79, occludedByHands=0.2)},
    {"faces": [dict(x=0.6, y=0.18, w=0.16, h=0.1)],
     "Fridge shelves": dict(box=dict(x=0.05, y=0.3, w=0.38, h=0.65), salience=0.74, occludedByHands=0.2, textPresent=True)},
    {"faces": [dict(x=0.3, y=0.5, w=0.18, h=0.1)],
     "Counter standee and cans": dict(box=dict(x=0.24, y=0.63, w=0.33, h=0.29), salience=0.77),
     "Two cans": dict(box=dict(x=0.57, y=0.66, w=0.37, h=0.19), salience=0.6)},
]

# (shot index, label) -> (brand line, fit, why, surface note)
PICKS: dict[tuple[int, str], tuple[str, float, str, str]] = {
    (1, "Cups on the table"): ("brewno", 0.94, "Morning café, cup already in hand.", "Plain white cup in a sharp close-up; a branded cup reads as set dressing, not an ad."),
    (0, "Cups on the table"): ("brewno", 0.94, "Morning café, cup already in hand.", "Plain white cup in a sharp close-up; a branded cup reads as set dressing, not an ad."),
    (0, "Blank café wall"): ("wanderly", 0.81, "Daydreamy café wall suits travel.", "Large untextured wall behind both actors; a framed travel poster fits the café."),
    (2, "Tee and cap"): ("", 0.62, "", "Clean garment surfaces, but cloth folds with breathing; held as a concept."),
    (4, "Street billboard"): ("zipgo", 0.96, "He is walking home; rides fit.", "Huge blank billboard over a city street at dusk; a ride ad is exactly what lives here."),
    (5, "Bus shelter panel"): ("zipgo", 0.87, "Waiting for transport at night.", "Backlit shelter panel beside Kabir as he waits; ride-hailing matches the beat."),
    (6, "Laptop screen"): ("plateful", 0.92, "Late night, dinner not sorted.", "Blank laptop at night, late for dinner; a food order on screen sets up the next shot."),
    (7, "Delivery bag"): ("plateful", 0.89, "The order arrives at the door.", "Large plain paper bag held at chest height; pays off the order from the laptop."),
    (8, "Fridge shelves"): ("fizzup", 0.84, "Cold drinks for two, late night.", "Rows of unbranded cans he reaches into; the held can is the hard part."),
    (9, "Counter standee and cans"): ("paysa", 0.91, "He pays right at this counter.", "Blank standee where he pays, two teal cans beside it; payment and drink both belong."),
    (9, "Two cans"): ("fizzup", 0.86, "Same cans he took from the fridge.", "Two plain teal cans on the counter."),
}
