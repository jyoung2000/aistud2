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
    for phrase in ("blue sky area", "crimson thing"):
        m, ok, _ = s.semantic(phrase)
        assert ok and m.any(), phrase
