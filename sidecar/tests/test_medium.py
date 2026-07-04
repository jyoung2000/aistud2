"""Medium detection + medium-locked prompt compilation (photo / drawn / render_cg)."""
import numpy as np

from app.medium import detect_medium
from app.profiles import store, synth
from app.select_sam import SmartSelector


def _photo():
    rng = np.random.default_rng(7)
    yy, xx = np.mgrid[:300, :400]
    img = np.stack([(xx / 400 * 180 + 40), (yy / 300 * 160 + 50), ((xx + yy) / 700 * 140 + 60)], -1)
    return np.clip(img + rng.normal(0, 6, img.shape), 0, 255).astype(np.uint8)


def _drawn():
    img = np.full((300, 400, 3), 235, np.uint8)
    img[:150] = (120, 190, 240)
    img[150:] = (90, 200, 110)
    img[80:220, 120:280] = (250, 120, 90)
    img[78:222, 118:122] = 20
    img[78:222, 278:282] = 20
    img[78:82, 118:282] = 20
    img[218:222, 118:282] = 20
    return img


def _render():
    yy, xx = np.mgrid[:300, :400]
    return np.stack([(xx / 400 * 200 + 30), (yy / 300 * 180 + 40), 255 - (xx / 400 * 150)], -1).astype(np.uint8)


def _mask():
    m = np.zeros((300, 400), np.uint8)
    m[100:200, 150:250] = 255
    return m


def test_detect_three_mediums():
    assert detect_medium(_photo())["medium"] == "photo"
    assert detect_medium(_drawn())["medium"] == "drawn"
    assert detect_medium(_render())["medium"] == "render_cg"


def test_detection_never_raises():
    for junk in (np.zeros((4, 4, 3), np.uint8), np.full((50, 50, 3), 255, np.uint8)):
        out = detect_medium(junk)
        assert out["medium"] in ("photo", "drawn", "render_cg")


# --- compiler behavior: the prompt never crosses mediums --------------------------------

def test_drawn_image_suppresses_photorealistic_vocab_on_inpaint():
    prof, _ = store.load("flux-fill")
    res = synth.synthesize(prof, "remove the trash can", rgb=_drawn(), mask=_mask())
    p = res["prompt"].lower()
    assert "photorealistic" not in p, p
    assert "cel-shaded" in p or "illustration" in p


def test_photo_keeps_photo_vocab_on_inpaint():
    prof, _ = store.load("flux-fill")
    res = synth.synthesize(prof, "remove the trash can", rgb=_photo(), mask=_mask())
    assert "photorealistic" in res["prompt"].lower()


def test_drawn_image_gets_style_lock_on_instruction():
    prof, _ = store.load("flux-kontext")
    res = synth.synthesize(prof, "make the car blue", rgb=_drawn(), mask=_mask())
    p = res["prompt"].lower()
    assert "hand-drawn" in p or "animated style" in p
    assert "do not make it photorealistic" in p


def test_render_gets_cg_lock():
    prof, _ = store.load("flux-kontext")
    res = synth.synthesize(prof, "make the car blue", rgb=_render(), mask=_mask())
    assert "3d-rendered" in res["prompt"].lower()


def test_restyle_beats_the_medium_lock():
    """'make it watercolor' is a deliberate medium change — the lock must not fight it."""
    prof, _ = store.load("flux-kontext")
    res = synth.synthesize(prof, "make it watercolor style", rgb=_drawn(), mask=_mask())
    assert "do not make it photorealistic" not in res["prompt"].lower()


def test_medium_override_wins():
    prof, _ = store.load("flux-kontext")
    res = synth.synthesize(prof, "make the car blue", rgb=_photo(), mask=_mask(), medium="drawn")
    assert "hand-drawn" in res["prompt"].lower()


def test_drawn_decompose_layers_flat_regions():
    s = SmartSelector()
    img = _drawn()
    s.set_image(img, "d")
    regions = s.decompose()
    names = [r["name"] for r in regions]
    assert names[0] == "Background"
    assert any(n.startswith("Object") for n in names)
    # the red rectangle should be one of the object layers
    obj_masks = [r["mask"] for r in regions if r["name"].startswith("Object")]
    assert any(m[150, 200] > 0 for m in obj_masks)