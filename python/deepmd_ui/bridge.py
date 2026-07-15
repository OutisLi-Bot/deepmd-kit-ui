# SPDX-License-Identifier: LGPL-3.0-or-later
"""Machine-readable bridge between DeePMD-kit and DeePMD Studio."""

from __future__ import annotations

import argparse
import copy
import importlib.metadata
import importlib.util
import json
import os
import platform
import re
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

_HIDDEN_WORKFLOWS = {
    "convert-from",
    "doc-train-input",
    "gui",
    "train-nvnmd",
    "transfer",
}

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
        if name not in _HIDDEN_WORKFLOWS
    ]
    categories = [
        "Training",
        "Evaluate",
        "Models",
        "Data",
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


_CHOICE_SEGMENT_PATTERNS = (
    re.compile(
        r"\bmust be (?:one of|either)\s+(.*?)(?=(?:\.\s)|$)",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\bsupported (?:activation functions|options)\s+are\s*:?\s*"
        r"(.*?)(?=(?:\.\s)|$)",
        re.IGNORECASE | re.DOTALL,
    ),
    re.compile(
        r"\boptions\s*:\s*(.*?)(?=(?:\.\s)|$)",
        re.IGNORECASE | re.DOTALL,
    ),
)
_QUOTED_CHOICE_PATTERN = re.compile(r"[\"']([^\"']+)[\"']")
_DASHED_CHOICE_PATTERN = re.compile(r"-\s*[\"']([^\"']+)[\"']")
_BARE_CHOICE_PATTERN = re.compile(
    r"[A-Za-z][A-Za-z0-9_:+-]*(?:\.[A-Za-z0-9_:+-]+)*"
)
_CHOICE_STOPWORDS = {
    "and",
    "currently",
    "following",
    "only",
    "or",
}


def _extract_choices(text: str) -> list[str]:
    """Extract a closed set of documented values from one constraint string."""
    for pattern in _CHOICE_SEGMENT_PATTERNS:
        match = pattern.search(text)
        if match is None:
            continue
        segment = match.group(1)
        dashed = _DASHED_CHOICE_PATTERN.findall(text[match.start(1) :])
        if len(dashed) > 1:
            return list(dict.fromkeys(candidate.strip() for candidate in dashed))
        quoted = _QUOTED_CHOICE_PATTERN.findall(segment)
        candidates = quoted or [
            token
            for token in _BARE_CHOICE_PATTERN.findall(segment)
            if token.lower() not in _CHOICE_STOPWORDS
        ]
        return list(dict.fromkeys(candidate.strip() for candidate in candidates))
    return []


def _enrich_argument_choices(serialized: dict[str, Any], argument: Any) -> None:
    """Restore finite-value metadata omitted by ``dargs.Argument.gen_json``."""
    if "str" in serialized.get("type", []):
        constraint = str(getattr(argument, "extra_check_errmsg", "") or "")
        choices = _extract_choices(constraint) or _extract_choices(
            str(getattr(argument, "doc", "") or "")
        )
        if choices:
            serialized["choices"] = choices

    live_fields = getattr(argument, "sub_fields", {})
    for name, field in serialized.get("sub_fields", {}).items():
        live_field = live_fields.get(name)
        if live_field is not None:
            _enrich_argument_choices(field, live_field)

    live_variants = getattr(argument, "sub_variants", {})
    for flag_name, variant in serialized.get("sub_variants", {}).items():
        live_variant = live_variants.get(flag_name)
        if live_variant is None:
            continue
        for tag, choice in variant.get("choice_dict", {}).items():
            live_choice = live_variant.choice_dict.get(tag)
            if live_choice is not None:
                _enrich_argument_choices(choice, live_choice)


def build_training_schema() -> dict[str, Any]:
    """Return the authoritative, version-matched training argument tree.

    The dargs serialization retains hierarchy, variants, defaults, aliases,
    required fields, and the documentation written in DeePMD's ``argcheck``.
    NVNMD is deliberately omitted because DeePMD Studio ships modern Python
    backends only.

    Returns
    -------
    dict[str, Any]
        Versioned dargs tree enriched with finite scalar choices for GUI controls.
    """
    from deepmd.utils.argcheck import (
        gen_args,
        gen_json,
    )

    # === Step.1 Serialize the authoritative dargs tree ===
    arguments = [
        argument
        for argument in json.loads(gen_json())
        if argument.get("name") != "nvnmd"
    ]

    # === Step.2 Restore validation choices that dargs omits from JSON ===
    live_arguments = {argument.name: argument for argument in gen_args()}
    for argument in arguments:
        live_argument = live_arguments.get(argument["name"])
        if live_argument is not None:
            _enrich_argument_choices(argument, live_argument)

    return {
        "schema_version": 1,
        "deepmd_version": DEEPMD_VERSION,
        "arguments": arguments,
    }


def _training_summary(data: dict[str, Any]) -> dict[str, Any]:
    model = data.get("model") or {}
    training = data.get("training") or {}
    training_data = training.get("training_data") or {}
    systems = training_data.get("systems", ".")
    if isinstance(systems, list):
        system_count = len(systems)
    elif systems:
        system_count = 1
    else:
        system_count = 0
    model_type = model.get("type", "standard")
    descriptor = model.get("descriptor") or {}
    if model_type == "standard":
        model_label = descriptor.get("type", "standard")
    else:
        model_label = model_type
    steps = next(
        (
            training[key]
            for key in ("numb_steps", "num_steps", "num_step", "numb_step")
            if key in training
        ),
        1_000_000,
    )
    optimizer = data.get("optimizer") or {}
    return {
        "model": model_label,
        "model_type": model_type,
        "optimizer": optimizer.get("type", "Adam"),
        "steps": steps,
        "systems": systems,
        "system_count": system_count,
    }


def validate_training_input(request: dict[str, Any]) -> dict[str, Any]:
    """Load or validate a training input with DeePMD's own argcheck logic."""
    try:
        if "path" in request:
            from deepmd.common import j_loader

            path = Path(str(request["path"])).expanduser().resolve()
            data = j_loader(path)
            source_path = str(path)
            working_directory = str(path.parent)
        else:
            data = request.get("input")
            source_path = None
            working_directory = None
        if not isinstance(data, dict):
            raise TypeError("The training input must be a JSON/YAML object.")

        from deepmd.utils.argcheck import normalize

        multi_task = "model_dict" in (data.get("model") or {})
        normalize(copy.deepcopy(data), multi_task=multi_task, check=True)
        return {
            "valid": True,
            "error": None,
            "input": data,
            "summary": _training_summary(data),
            "source_path": source_path,
            "working_directory": working_directory,
        }
    except Exception as error:
        return {
            "valid": False,
            "error": str(error),
            "input": None,
            "summary": None,
            "source_path": request.get("path"),
            "working_directory": None,
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
        choices=("catalog", "doctor", "train-schema", "validate-input"),
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
    # Windows inherits a locale code page for redirected standard streams.
    # Argcheck documentation contains scientific Unicode (for example Å),
    # and request paths may contain non-ASCII characters, so the machine
    # protocol must never depend on that process-global locale.
    stdin_reconfigure = getattr(sys.stdin, "reconfigure", None)
    if stdin_reconfigure is not None:
        # ``utf-8-sig`` also accepts BOM-prefixed input emitted by Windows
        # PowerShell while behaving like UTF-8 for Rust's BOM-free payloads.
        stdin_reconfigure(encoding="utf-8-sig")
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    namespace = _build_parser().parse_args(args)
    if namespace.command == "catalog":
        payload = build_catalog()
    elif namespace.command == "doctor":
        payload = build_runtime_report()
    elif namespace.command == "train-schema":
        payload = build_training_schema()
    else:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise TypeError("bridge request must be a JSON object")
        payload = validate_training_input(request)
    json.dump(
        payload,
        sys.stdout,
        ensure_ascii=False,
        indent=2 if namespace.pretty else None,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
