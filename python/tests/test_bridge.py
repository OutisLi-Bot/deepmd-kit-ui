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
