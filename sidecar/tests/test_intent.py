"""Unit tests for the Stage-2 intent parser: casual text → structured EditSpec."""
import pytest

from app.prompting.intent import parse_intent


# (text, expected_operation, expected_target, expected_new_content) — None = don't check
CASES = [
    # text edits
    ("replace 'OPEN' with 'CLOSED'", "text_edit", "OPEN", "CLOSED"),
    ('change the sign to say "SALE"', "text_edit", None, "SALE"),
    ("the label should read 'Fresh Juice'", "text_edit", None, "Fresh Juice"),
    # remove
    ("remove the trash can", "remove", "trash can", None),
    ("delete the person in the back", "remove", "person in the back", None),
    ("get rid of the watermark", "remove", "watermark", None),
    ("erase it", "remove", None, None),
    ("make it disappear", "remove", None, None),
    ("without the hat", "remove", "hat", None),
    # background swap
    ("change the background to a sunny beach", "background_swap", "background", "a sunny beach"),
    ("swap the backdrop for a city skyline at night", "background_swap", "background", None),
    ("put them on a beach background", "background_swap", "background", None),
    # replace / turn into
    ("replace the jacket with a red dress", "replace", "jacket", "a red dress"),
    ("turn the car into a motorcycle", "replace", "car", "a motorcycle"),
    ("change the apple to an orange", "replace", "apple", "an orange"),
    ("swap out the lamp for a plant", "replace", "lamp", "a plant"),
    ("make the frown into a smile", "replace", "frown", "a smile"),
    # replace downgrade: pure color/material new_content
    ("change the shirt to blue", "recolor", "shirt", "blue"),
    ("turn the table into marble", "retexture", "table", "marble"),
    # add
    ("add a small dog", "add", None, "small dog"),
    ("put a hat on him", "add", None, None),
    ("wearing a red scarf", "add", None, "wearing a red scarf"),
    # pose / expression
    ("raise her arms above her head", "pose_change", None, None),
    ("change the pose so he's sitting", "pose_change", None, None),
    ("make him smile", "expression", None, None),
    ("give her a surprised expression", "expression", None, None),
    # relight
    ("golden hour lighting", "relight", None, None),
    ("make the lighting more dramatic", "relight", None, None),
    ("brighter", "relight", None, None),
    # upscale / detail
    ("make it sharper", "upscale_detail", None, None),
    ("more detail please", "upscale_detail", None, None),
    # recolor
    ("make the car blue", "recolor", "car", "blue"),
    ("paint the wall green", "recolor", "wall", "green"),
    ("dye her hair purple", "recolor", "hair", "purple"),
    # retexture
    ("make the table marble", "retexture", "table", "marble"),
    ("make the jacket leather", "retexture", "jacket", "leather"),
    # restyle
    ("in the style of a watercolor painting", "restyle", None, None),
    ("make it look cyberpunk", "restyle", None, None),
    ("anime version", "restyle", None, None),
]


@pytest.mark.parametrize("text,op,target,new", CASES)
def test_rule(text, op, target, new):
    spec = parse_intent(text)
    assert spec.operation == op, f"{text!r} → {spec.operation} (rule {spec.rule}), wanted {op}"
    if target is not None:
        assert spec.target_noun == target, (text, spec.target_noun)
    if new is not None:
        assert spec.new_content == new, (text, spec.new_content)


def test_empty_is_ambiguous():
    spec = parse_intent("")
    assert spec.ambiguities and spec.specificity == "low"


def test_vague_flags_ambiguity():
    spec = parse_intent("make it better")
    assert spec.ambiguities and "better" in spec.ambiguities[0]


def test_preserve_extraction():
    spec = parse_intent("change the jacket to a red dress, keep the face the same")
    assert spec.operation in ("replace", "recolor")
    assert any("face" in p for p in spec.preserve)


def test_attributes_collected():
    spec = parse_intent("replace the jacket with a red leather jacket")
    assert "red" in spec.attributes and "leather" in spec.attributes


def test_specificity_scale():
    assert parse_intent("fix").specificity == "low"
    assert parse_intent("replace the old wooden fence with a modern black metal fence").specificity == "high"


def test_never_raises_on_junk():
    for junk in ("???", "asdf qwer zxcv", "🎨🎨🎨", "a" * 500, "   "):
        spec = parse_intent(junk)
        assert spec.operation  # always lands on something
