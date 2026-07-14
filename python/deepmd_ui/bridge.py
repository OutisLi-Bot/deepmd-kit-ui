# SPDX-License-Identifier: LGPL-3.0-or-later
"""Machine-readable bridge between DeePMD-kit and DeePMD Studio."""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import platform
import sys
from collections.abc import (
    Sequence,
)
from pathlib import (
    Path,
)
from typing import (
    Any,
)

from deepmd.main import (
    BACKEND_TABLE,
    main_parser,
)

try:
    from deepmd._version import version as DEEPMD_VERSION
except ImportError:
    DEEPMD_VERSION = "unknown"


_WORKFLOW_METADATA: dict[str, dict[str, Any]] = {
    "train": {
        "category": "Training",
        "title": "Train a model",
        "description": "Fit a Deep Potential model from a JSON or YAML configuration.",
        "icon": "sparkles",
        "accent": "violet",
        "featured": True,
    },
    "freeze": {
        "category": "Models",
        "title": "Freeze checkpoint",
        "description": "Export a training checkpoint as a portable inference model.",
        "icon": "snowflake",
        "accent": "blue",
        "featured": True,
    },
    "test": {
        "category": "Evaluate",
        "title": "Test a model",
        "description": "Measure model errors on one or more labeled systems.",
        "icon": "flask-conical",
        "accent": "emerald",
        "featured": True,
    },
    "model-devi": {
        "category": "Evaluate",
        "title": "Model deviation",
        "description": "Evaluate uncertainty from an ensemble of trained models.",
        "icon": "activity",
        "accent": "amber",
    },
    "eval-desc": {
        "category": "Evaluate",
        "title": "Evaluate descriptors",
        "description": "Inspect descriptor output for selected systems and atoms.",
        "icon": "scan-search",
        "accent": "cyan",
    },
    "embed": {
        "category": "Evaluate",
        "title": "Model embeddings",
        "description": "Export descriptors, atomic features, or structural features.",
        "icon": "boxes",
        "accent": "cyan",
    },
    "show": {
        "category": "Models",
        "title": "Inspect model",
        "description": "Show metadata and supported capabilities of a model.",
        "icon": "info",
        "accent": "slate",
    },
    "compress": {
        "category": "Models",
        "title": "Compress model",
        "description": "Tabulate eligible networks for faster inference.",
        "icon": "archive-restore",
        "accent": "indigo",
    },
    "change-bias": {
        "category": "Models",
        "title": "Change output bias",
        "description": "Recalibrate model output bias using a dataset.",
        "icon": "sliders-horizontal",
        "accent": "rose",
    },
    "convert-backend": {
        "category": "Models",
        "title": "Convert backend",
        "description": "Convert a portable model to another supported backend.",
        "icon": "repeat-2",
        "accent": "violet",
    },
    "neighbor-stat": {
        "category": "Data",
        "title": "Neighbor statistics",
        "description": "Calculate minimum distances and neighbor counts for data systems.",
        "icon": "radar",
        "accent": "teal",
    },
    "pretrained": {
        "category": "Models",
        "title": "Pretrained models",
        "description": "Discover and manage built-in pretrained models.",
        "icon": "library",
        "accent": "orange",
    },
    "doc-train-input": {
        "category": "Utilities",
        "title": "Input reference",
        "description": "Generate the authoritative training-input reference.",
        "icon": "book-open-text",
        "accent": "slate",
    },
    "transfer": {
        "category": "Utilities",
        "title": "Transfer parameters",
        "description": "Transfer compatible TensorFlow parameters between models.",
        "icon": "arrow-right-left",
        "accent": "slate",
    },
    "convert-from": {
        "category": "Utilities",
        "title": "Upgrade model format",
        "description": "Convert an older TensorFlow model to the current format.",
        "icon": "file-up",
        "accent": "slate",
    },
    "train-nvnmd": {
        "category": "Advanced",
        "title": "Train NVNMD",
        "description": "Run the TensorFlow NVNMD training workflow.",
        "icon": "cpu",
        "accent": "slate",
    },
    "gui": {
        "category": "Utilities",
        "title": "Legacy DP-GUI server",
        "description": "Launch the existing browser-based DP-GUI server.",
        "icon": "panel-top-open",
        "accent": "slate",
        "legacy": True,
    },
}

_PATH_HINTS = {
    "checkpoint",
    "datafile",
    "directory",
    "file",
    "folder",
    "input",
    "log_path",
    "model",
    "output",
    "path",
    "restart",
    "system",
}


def _json_value(value: Any) -> Any:
    """Convert an argparse value to a JSON-compatible representation."""
    if value is argparse.SUPPRESS:
        return None
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [_json_value(item) for item in value]
    return str(value)


def _field_kind(action: argparse.Action) -> str:
    """Infer the most useful UI field type for an argparse action."""
    if isinstance(action, (argparse._StoreTrueAction, argparse._StoreFalseAction)):
        return "boolean"
    if action.choices is not None:
        return "select"
    if action.type is int:
        return "integer"
    if action.type is float:
        return "number"
    normalized = action.dest.lower()
    if any(hint in normalized for hint in _PATH_HINTS):
        return "path"
    return "text"


def _serialize_action(
    action: argparse.Action,
    mutex_by_action: dict[int, str],
    condition: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Serialize one argparse action for GUI and TUI form generation."""
    positional = not action.option_strings
    nargs = action.nargs
    required = bool(getattr(action, "required", False))
    if positional and nargs not in ("?", "*"):
        required = True
    return {
        "id": action.dest,
        "flags": list(action.option_strings),
        "positional": positional,
        "required": required,
        "kind": _field_kind(action),
        "nargs": _json_value(nargs),
        "default": _json_value(action.default),
        "choices": (
            [_json_value(choice) for choice in action.choices]
            if action.choices is not None
            else []
        ),
        "help": action.help or "",
        "metavar": _json_value(action.metavar),
        "mutex_group": mutex_by_action.get(id(action)),
        "condition": condition,
    }


def _serialize_parser(name: str, parser: argparse.ArgumentParser) -> dict[str, Any]:
    """Serialize a DeePMD subcommand parser."""
    mutex_by_action: dict[int, str] = {}
    for index, group in enumerate(parser._mutually_exclusive_groups):
        group_id = f"mutex-{index}"
        for action in group._group_actions:
            mutex_by_action[id(action)] = group_id
    arguments = []
    for action in parser._actions:
        if isinstance(action, argparse._HelpAction):
            continue
        if not isinstance(action, argparse._SubParsersAction):
            arguments.append(_serialize_action(action, mutex_by_action))
            continue

        arguments.append(
            {
                "id": action.dest,
                "flags": [],
                "positional": True,
                "required": bool(action.required),
                "kind": "select",
                "nargs": None,
                "default": _json_value(action.default),
                "choices": list(action.choices),
                "help": action.help or "Choose an action.",
                "metavar": _json_value(action.metavar),
                "mutex_group": None,
                "condition": None,
            }
        )
        for choice, nested_parser in action.choices.items():
            nested_mutex: dict[int, str] = {}
            for index, group in enumerate(nested_parser._mutually_exclusive_groups):
                for nested_action in group._group_actions:
                    nested_mutex[id(nested_action)] = (
                        f"{action.dest}-{choice}-mutex-{index}"
                    )
            condition = {"field": action.dest, "equals": choice}
            arguments.extend(
                _serialize_action(nested_action, nested_mutex, condition)
                for nested_action in nested_parser._actions
                if not isinstance(
                    nested_action,
                    (argparse._HelpAction, argparse._SubParsersAction),
                )
            )
    metadata = {
        "category": "Advanced",
        "title": name.replace("-", " ").title(),
        "description": parser.description or "",
        "icon": "terminal-square",
        "accent": "slate",
    }
    metadata.update(_WORKFLOW_METADATA.get(name, {}))
    return {
        "name": name,
        "usage": parser.format_usage().strip(),
        "arguments": arguments,
        **metadata,
    }


def build_catalog() -> dict[str, Any]:
    """Build the complete machine-readable DeePMD CLI catalog.

    Returns
    -------
    dict[str, Any]
        Backend aliases, categories, and every registered subcommand with its
        arguments.
    """
    parser = main_parser()
    subparsers = next(
        action
        for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    )
    commands = [
        _serialize_parser(name, command_parser)
        for name, command_parser in subparsers.choices.items()
    ]
    categories = [
        "Training",
        "Evaluate",
        "Models",
        "Data",
        "Utilities",
        "Advanced",
    ]
    backend_aliases: dict[str, list[str]] = {}
    for alias, backend in BACKEND_TABLE.items():
        backend_aliases.setdefault(backend, []).append(alias)
    return {
        "schema_version": 1,
        "deepmd_version": DEEPMD_VERSION,
        "categories": categories,
        "backends": [
            {
                "id": backend,
                "aliases": sorted(aliases, key=len),
                "flag": f"--{min(aliases, key=len)}",
                "available": True,
            }
            for backend, aliases in sorted(backend_aliases.items())
        ],
        "commands": commands,
    }


def _backend_availability() -> list[dict[str, Any]]:
    """Return lightweight backend availability without importing all frameworks."""
    package_by_backend = {
        "tensorflow": "tensorflow",
        "tensorflow2": "tensorflow",
        "pytorch": "torch",
        "pytorch-exportable": "torch",
        "jax": "jax",
        "paddle": "paddle",
        "dpmodel": "numpy",
    }
    rows = []
    seen: set[str] = set()
    for backend in BACKEND_TABLE.values():
        if backend in seen:
            continue
        seen.add(backend)
        package = package_by_backend.get(backend)
        rows.append(
            {
                "id": backend,
                "package": package,
                "available": bool(package and importlib.util.find_spec(package)),
            }
        )
    return sorted(rows, key=lambda item: item["id"])


def _accelerator_report() -> dict[str, Any]:
    """Inspect the active accelerator using PyTorch when available."""
    report: dict[str, Any] = {
        "kind": "cpu",
        "available": False,
        "devices": [],
    }
    if importlib.util.find_spec("torch") is None:
        return report
    try:
        import torch

        report["torch_version"] = torch.__version__
        report["cuda_version"] = torch.version.cuda
        if torch.cuda.is_available():
            report["kind"] = "cuda"
            report["available"] = True
            report["devices"] = [
                {
                    "index": index,
                    "name": torch.cuda.get_device_name(index),
                    "memory_bytes": torch.cuda.get_device_properties(
                        index
                    ).total_memory,
                }
                for index in range(torch.cuda.device_count())
            ]
        elif (
            hasattr(torch.backends, "mps")
            and torch.backends.mps.is_built()
            and torch.backends.mps.is_available()
        ):
            report["kind"] = "mps"
            report["available"] = True
            report["devices"] = [
                {
                    "index": 0,
                    "name": "Apple Metal Performance Shaders",
                    "memory_bytes": 0,
                }
            ]
    except Exception as error:  # pragma: no cover - depends on local drivers
        report["error"] = str(error)
    return report


def _triton_report() -> dict[str, Any]:
    """Inspect the optional Triton compiler without requiring a GPU driver."""
    report: dict[str, Any] = {
        "available": False,
        "driver_ready": False,
    }
    if importlib.util.find_spec("triton") is None:
        return report
    try:
        import triton

        report["available"] = True
        report["version"] = triton.__version__
        try:
            triton.runtime.driver.active.get_current_target()
            report["driver_ready"] = True
        except Exception as error:  # pragma: no cover - hardware dependent
            report["driver_error"] = str(error)
    except Exception as error:  # pragma: no cover - installation dependent
        report["error"] = str(error)
    try:
        report["distribution"] = importlib.metadata.version("triton-windows")
    except importlib.metadata.PackageNotFoundError:
        pass
    return report


def _runtime_manifest() -> dict[str, Any] | None:
    """Load provenance for the application-owned runtime when available."""
    path = Path(sys.prefix) / "deepmd-ui-runtime.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def build_runtime_report() -> dict[str, Any]:
    """Build a runtime and backend diagnostic report.

    Returns
    -------
    dict[str, Any]
        Platform, Python, DeePMD, backend, and accelerator information.
    """
    deepmd_spec = importlib.util.find_spec("deepmd")
    package_root = (
        str(Path(deepmd_spec.origin).resolve().parent)
        if deepmd_spec is not None and deepmd_spec.origin is not None
        else "unknown"
    )
    return {
        "schema_version": 1,
        "deepmd_version": DEEPMD_VERSION,
        "python": {
            "version": platform.python_version(),
            "executable": sys.executable,
            "prefix": sys.prefix,
            "bundled": bool(getattr(sys, "frozen", False))
            or os.environ.get("DPMD_STUDIO_BUNDLED") == "1",
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "node": platform.node(),
        },
        "package_root": package_root,
        "backends": _backend_availability(),
        "accelerator": _accelerator_report(),
        "triton": _triton_report(),
        "runtime_manifest": _runtime_manifest(),
    }


def _build_parser() -> argparse.ArgumentParser:
    """Create the bridge command parser."""
    parser = argparse.ArgumentParser(
        prog="python -m deepmd_ui.bridge",
        description="Machine-readable DeePMD Studio bridge.",
    )
    parser.add_argument(
        "command",
        choices=("catalog", "doctor"),
        help="Bridge operation to perform.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Indent JSON for people instead of emitting compact agent output.",
    )
    return parser


def main(args: Sequence[str] | None = None) -> None:
    """Emit a bridge response as JSON.

    Parameters
    ----------
    args : Sequence[str] or None, optional
        Command-line arguments. ``sys.argv`` is used when omitted.
    """
    namespace = _build_parser().parse_args(args)
    payload = (
        build_catalog() if namespace.command == "catalog" else build_runtime_report()
    )
    json.dump(
        payload,
        sys.stdout,
        ensure_ascii=False,
        indent=2 if namespace.pretty else None,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
