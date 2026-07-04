"""Find (select-by-text) CPU fallback chain: color words, subject, background, no-match."""
import numpy as np

from app.select_sam import SmartSelector


def _scene():
    """Blue background, red square, skin-toned blob (a crude 'person')."""
    img = np.zeros((200, 300, 3), np.uint8)
    img[:, :] = (60, 90, 200)
    img[120:180, 40:110] = (200, 40, 30)
    img[40:110, 150:220] = (190, 130, 90)
    s = SmartSelector()
    s.set_image(img, "t")
    return s


def test_color_word_selects_color_regions():
    s = _scene()
    m, ok, note = s.semantic("the red ball")
    assert ok and m[150, 70] > 0 and m[60, 30] == 0
    assert "red" in note


def test_background_word_inverts_subject():
    s = _scene()
    m, ok, note = s.semantic("change the background")
    assert ok and m.any()
    assert "background" in note


def test_subject_word_finds_subject():
    s = _scene()
    m, ok, _ = s.semantic("the person")
    assert ok and m.any()


def test_no_match_is_honest():
    s = _scene()
    m, ok, note = s.semantic("the bicycle")
    assert not ok and not m.any()
    assert "couldn't match" in note


def test_color_synonyms():
    s = _scene()
    for phrase in ("blue water", "crimson thing"):
        m, ok, _ = s.semantic(phrase)
        assert ok and m.any(), phrase


def _outdoor_scene():
    """Sky gradient on top, green ground, bright sun disk, skin blob."""
    img = np.zeros((200, 300, 3), np.uint8)
    img[:90, :] = (120, 170, 230)     # pale blue sky (top)
    img[90:, :] = (60, 160, 70)       # green ground
    yy, xx = np.mgrid[:200, :300]
    sun = (yy - 40) ** 2 + (xx - 240) ** 2 <= 18 ** 2
    img[sun] = (250, 245, 200)        # bright sun disk
    img[120:170, 40:100] = (190, 130, 90)  # skin blob
    s = SmartSelector()
    s.set_image(img, "t2")
    return s


def test_sun_selects_brightest_blob():
    s = _outdoor_scene()
    m, ok, note = s.semantic("select the sun")
    assert ok and m[40, 240] > 0 and m[150, 150] == 0
    assert "brightest" in note


def test_sky_selects_top_region():
    s = _outdoor_scene()
    m, ok, _ = s.semantic("the sky")
    assert ok and m[10, 150] > 0 and m[150, 150] == 0


def test_grass_maps_to_green():
    s = _outdoor_scene()
    m, ok, _ = s.semantic("the grass")
    assert ok and m[150, 150] > 0 and m[10, 150] == 0


def test_skin_words():
    s = _outdoor_scene()
    m, ok, _ = s.semantic("her hands")
    assert ok and m[140, 70] > 0
