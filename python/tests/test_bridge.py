# SPDX-License-Identifier: LGPL-3.0-or-later
"""Tests for the machine-readable DeePMD Studio bridge."""

from deepmd.main import (
    main_parser,
)
from deepmd_ui.bridge import (
    build_catalog,
    build_runtime_report,
    build_training_schema,
    validate_training_input,
)


def test_catalog_covers_supported_deepmd_commands() -> None:
    """The Studio catalog stays in sync while omitting legacy utilities."""
    parser = main_parser()
    subparser_action = next(
        action
        for action in parser._actions
        if hasattr(action, "choices") and isinstance(action.choices, dict)
    )
    catalog = build_catalog()
    catalog_commands = {command["name"] for command in catalog["commands"]}
    hidden = {"convert-from", "doc-train-input", "gui", "train-nvnmd", "transfer"}
    assert catalog_commands == set(subparser_action.choices) - hidden
    assert catalog["categories"] == ["Training", "Evaluate", "Models", "Data"]


def test_catalog_exposes_train_form_fields() -> None:
    """The main training workflow contains its required input and safety flag."""
    catalog = build_catalog()
    train = next(
        command for command in catalog["commands"] if command["name"] == "train"
    )
    arguments = {argument["id"]: argument for argument in train["arguments"]}
    assert arguments["INPUT"]["required"] is True
    assert arguments["INPUT"]["kind"] == "path"
    assert arguments["skip_neighbor_stat"]["kind"] == "boolean"


def test_catalog_serializes_nested_pretrained_command() -> None:
    """Nested argparse commands become conditional form fields."""
    catalog = build_catalog()
    pretrained = next(
        command for command in catalog["commands"] if command["name"] == "pretrained"
    )
    fields = {field["id"]: field for field in pretrained["arguments"]}
    assert fields["pretrained_command"]["choices"] == ["download"]
    assert fields["MODEL"]["condition"] == {
        "field": "pretrained_command",
        "equals": "download",
    }
    assert fields["cache_dir"]["condition"] == fields["MODEL"]["condition"]


def test_runtime_report_is_structured() -> None:
    """Runtime diagnostics expose the fields consumed by both clients."""
    report = build_runtime_report()
    assert report["deepmd_version"]
    assert report["python"]["executable"]
    assert report["platform"]["system"]
    assert isinstance(report["backends"], list)
    assert report["accelerator"]["kind"] in {"cpu", "cuda", "mps"}
    assert isinstance(report["triton"]["available"], bool)
    assert isinstance(report["triton"]["driver_ready"], bool)
    assert report["runtime_manifest"] is None or isinstance(
        report["runtime_manifest"], dict
    )


def test_training_schema_is_argcheck_driven_without_nvnmd() -> None:
    schema = build_training_schema()
    arguments = {argument["name"]: argument for argument in schema["arguments"]}
    assert "model" in arguments
    assert "training" in arguments
    assert "nvnmd" not in arguments
    model_types = arguments["model"]["sub_variants"]["type"]["choice_dict"]
    assert "dpa4" in model_types


def test_training_schema_exposes_closed_value_choices() -> None:
    """Finite argcheck constraints become version-matched select options."""
    schema = build_training_schema()

    def walk(argument: dict) -> list[dict]:
        nested = [argument]
        for field in argument["sub_fields"].values():
            nested.extend(walk(field))
        for variant in argument["sub_variants"].values():
            for choice in variant["choice_dict"].values():
                nested.extend(walk(choice))
        return nested

    fields = [
        field
        for argument in schema["arguments"]
        for field in walk(argument)
    ]
    activation_choices = [
        field["choices"]
        for field in fields
        if field["name"] == "activation_function" and "choices" in field
    ]
    assert any("silu" in choices and "tanh" in choices for choices in activation_choices)
    assert any(
        field["name"] == "precision"
        and {"default", "float32", "float64"}.issubset(field.get("choices", []))
        for field in fields
    )
    assert any(
        field["name"] == "so2_attn_res"
        and field.get("choices") == ["none", "independent", "dependent"]
        for field in fields
    )
    assert any(
        field["name"] == "stat_file_mode"
        and field.get("choices") == ["read", "update"]
        for field in fields
    )
    assert any(
        field["name"] == "update_style"
        and field.get("choices") == ["res_avg", "res_incr", "res_residual"]
        for field in fields
    )
    assert not any(
        choice.lower().rstrip(".") == "currently"
        for field in fields
        for choice in field.get("choices", [])
    )


def test_generated_training_input_is_validated_by_argcheck() -> None:
    result = validate_training_input(
        {
            "input": {
                "model": {
                    "type": "dpa4",
                    "descriptor": {"type": "dpa4"},
                    "fitting_net": {"type": "dpa4_ener"},
                },
                "training": {
                    "training_data": {"systems": "."},
                    "numb_steps": 1,
                },
            }
        }
    )
    assert result["valid"] is True
    assert result["summary"]["model"] == "dpa4"
