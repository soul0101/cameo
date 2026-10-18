from cameo_agents.schemas import Box, NormBox, SceneUnderstanding, ScenesPageOutput, Suggestion, ProductSuggestion, to_web_json


def test_box_2d_to_norm_box():
    b = NormBox.from_box_2d([100, 200, 400, 600])  # ymin, xmin, ymax, xmax on 0-1000
    assert (b.x, b.y, round(b.w, 3), round(b.h, 3)) == (0.2, 0.1, 0.4, 0.3)
    assert NormBox.from_box_2d([400, 600, 100, 200]) == b  # swapped corners are put in order


def test_iou_and_distance():
    a, b = NormBox(x=0, y=0, w=0.5, h=0.5), NormBox(x=0.25, y=0, w=0.5, h=0.5)
    assert abs(a.iou(b) - 1 / 3) < 1e-9
    assert a.distance(NormBox(x=0.6, y=0, w=0.1, h=0.1)) > 0.09


def test_page_roundtrip_and_web_shape():
    sc = SceneUnderstanding.model_validate({"shotId": "C01", "tIn": 0, "tOut": 8, "scene": {"type": "café", "mood": "warm"},
                                            "surfaces": [{"label": "Cup", "kind": "table", "timeVisible": 8}]})
    box = Box(id="C01-b1", shotId="C01", label="Cup", kind="table", box=NormBox(x=0.4, y=0.7, w=0.2, h=0.15), areaPct=3.0)
    sug = Suggestion(boxId="C01-b1", region="IN", suggestions=[ProductSuggestion(productId="brewno-in", fit=0.9, why="café")], defaultPrompt="Replace the cup.")
    page = ScenesPageOutput(episodeId="e", regions=["IN"], scenes=[sc], boxes=[box], suggestions={"IN": [sug]}, prompts={"IN": {"C01-b1": "Replace the cup."}}, skipped=[])
    again = ScenesPageOutput.model_validate_json(page.model_dump_json())
    assert again == page
    web = to_web_json(again)
    m = web["moments"][0]
    assert m["id"] == "M1" and m["mode"] == "replace" and m["surface"] == "table" and m["brandId"] == "brewno"
    assert set(m["box"]) == {"x", "y", "w", "h"} and m["scene"] == "Café"
    assert web["placements"][0]["id"] == "P1"
