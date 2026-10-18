"""Generate starter-catalog packshots with Nano Banana 2.1 for products that have only a logo (or nothing).

    .venv/bin/python scripts/gen_packshots.py [--only brewno-in,kora-jp] [--dry-run]

Each packshot is a studio product photo of the packaging alone (a closed takeaway cup, a sealed delivery bag, a
folded garment), never the food or drink inside, with the brand's logo from `web/public/brands/<id>-logo.jpg` given
as a reference image so the print matches. Output: `web/public/brands/<id>.jpg` (1:1, 1K). Existing files are skipped unless
named in --only. One image each, about $0.034.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from cameo_agents.api import load_env  # noqa: E402

ASSETS = HERE.parent / "web" / "public" / "brands"  # the starter photos the web app ships

STYLE = (
    "Studio product photograph (packshot) for an online catalog. One product, centred, front three-quarter view, "
    "on a seamless plain white background with a soft, natural contact shadow. Even softbox lighting, true-to-life "
    "colours, crisp focus, realistic materials and print, photographed with a 50 mm lens. Show only the product "
    "itself: no hands, no people, no props, no food or drink visible, no scenery, no text other than the logo and the words named below, no watermark."
)

LOGO_RULE = (
    "Print the brand logo from image 1 on it exactly as drawn: same shapes, colours and lettering, sharp and correctly "
    "spelled, wrapped naturally around the curved surface."
)

# id: (logo reference or None, what the product is)
JOBS: dict[str, tuple[str | None, str]] = {
    "brewno-in": ("brewno-in-logo.jpg", "A 12 oz takeaway paper coffee cup, matte cream white, with a warm brown "
                  "corrugated sleeve and a closed white plastic lid. The words \"Masala Chai\" in small brown type under the logo. "
                  "The cup is sealed; no drink is visible."),
    "brewno-jp": ("brewno-jp-logo.jpg", "A 12 oz takeaway paper cup, off-white with a thin navy band, and a closed "
                  "white plastic lid. The words \"Matcha Latte\" in small navy type under the logo. The cup is sealed; no drink is visible."),
    "brewno-id": ("brewno-id-logo.jpg", "A 12 oz takeaway paper cup, cream with a deep forest-green sleeve, and a "
                  "closed white plastic lid. The words \"Kopi Susu\" in small green type under the logo. The cup is sealed; no drink is visible."),
    "plateful-in": ("plateful-in-logo.jpg", "A food-delivery paper bag, matte black kraft with a folded, sealed top and a "
                    "gold sticker seal, standing upright. The gold logo is printed large on the front. The bag is closed; no food is visible."),
    "vela": (None, "A stylish cropped leather jacket in soft black lambskin, boxy fit ending at the waist, with a notched collar, "
             "a silver asymmetric zip and silver snaps, shown on an invisible mannequin from the front three-quarter angle, "
             "zipped open a little so the lining shows."),
    "kora-in": (None, "A crewneck sweatshirt in heather navy cotton fleece, neatly folded, with a small white \"KORA\" "
                "wordmark printed on the chest and a soft ribbed collar and cuffs."),
    "kora-jp": (None, "A crewneck sweatshirt in oatmeal cotton fleece, neatly folded, with a small charcoal \"KORA\" "
                "wordmark printed on the chest and a soft ribbed collar and cuffs."),
    "kora-id": (None, "A crewneck sweatshirt in forest green cotton fleece, neatly folded, with a small white \"KORA\" "
                "wordmark printed on the chest and a soft ribbed collar and cuffs."),
}


def prompt_for(logo: str | None, what: str) -> str:
    return " ".join(x for x in (f"Create a {STYLE[0].lower()}{STYLE[1:]}", f"The product: {what}", LOGO_RULE if logo else "") if x)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    todo = {k: v for k, v in JOBS.items() if (k in only) or (not only and not (ASSETS / f"{k}.jpg").is_file())}
    if not todo:
        print("nothing to generate")
        return 0
    if a.dry_run:
        for k, (logo, what) in todo.items():
            print(f"--- {k} (ref: {logo})\n{prompt_for(logo, what)}\n")
        return 0
    load_env()
    from google.genai import types

    from cameo_agents.preview import IMAGE_MODEL, GeminiImage, fit_to, with_backoff
    from clean_packshot import clean

    client = GeminiImage().client
    for k, (logo, what) in todo.items():
        parts = []
        if logo:
            parts.append(types.Part.from_bytes(data=(ASSETS / logo).read_bytes(), mime_type="image/jpeg"))
        parts.append(prompt_for(logo, what))
        cfg = types.GenerateContentConfig(response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1", image_size="1K"))
        resp = with_backoff(lambda: client.models.generate_content(model=IMAGE_MODEL, contents=parts, config=cfg))
        data = next((p.inline_data.data for c in resp.candidates or [] for p in (c.content.parts or []) if p.inline_data and p.inline_data.data), None)
        if not data:
            print(f"{k}: no image ({resp.candidates[0].finish_reason if resp.candidates else 'blocked'})")
            continue
        fit_to(data, 1024, 1024, ASSETS / f"{k}.jpg")
        clean(ASSETS / f"{k}.jpg")  # white backdrop, cropped to the product, like the other starter photos
        u = resp.usage_metadata
        print(f"{k}: ok · {u.prompt_token_count} in / {u.candidates_token_count} out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
