# SPDX-License-Identifier: LGPL-3.0-or-later
"""Tests for the machine-readable DeePMD Studio bridge."""

from deepmd.main import (
    main_parser,
)
from deepmd_ui.bridge import (
    build_catalog,
    build_runtime_report,
)


def test_catalog_covers_every_deepmd_command() -> None:
    """The Studio catalog stays in sync with the authoritative CLI parser."""
    parser = main_parser()
    subparser_action = next(
        action
        for action in parser._actions
        if hasattr(action, "choices") and isinstance(action.choices, dict)
    )
    catalog = build_catalog()
    catalog_commands = {command["name"] for command in catalog["commands"]}
    assert catalog_commands == set(subparser_action.choices)


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
