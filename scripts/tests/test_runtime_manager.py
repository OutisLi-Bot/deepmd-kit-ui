# SPDX-License-Identifier: LGPL-3.0-or-later
"""Unit tests for isolated runtime channel management."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "runtime_manager.py"
SPEC = importlib.util.spec_from_file_location("runtime_manager", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RUNTIME_MANAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME_MANAGER)


def test_github_repository_urls_are_normalized() -> None:
    assert (
        RUNTIME_MANAGER._github_slug("https://github.com/deepmodeling/deepmd-kit.git")
        == "deepmodeling/deepmd-kit"
    )
    assert (
        RUNTIME_MANAGER._github_slug("git@github.com:OutisLi-Bot/deepmd-kit.git")
        == "OutisLi-Bot/deepmd-kit"
    )


def test_github_proxy_wraps_original_url() -> None:
    original = "https://github.com/deepmodeling/deepmd-kit/archive/abc.zip"
    assert RUNTIME_MANAGER._proxied(original, "") == original
    assert RUNTIME_MANAGER._proxied(original, "https://gh-proxy.example/") == (
        "https://gh-proxy.example/" + original
    )


def test_github_proxy_url_template() -> None:
    original = "https://github.com/deepmodeling/deepmd-kit/archive/abc.zip"
    assert RUNTIME_MANAGER._proxied(
        original,
        "https://proxy.example/fetch?url={url}",
    ) == ("https://proxy.example/fetch?url=" + original)


def test_application_platform_keys() -> None:
    assert RUNTIME_MANAGER._platform_key("windows", "x86_64") == "windows-x86_64"
    assert RUNTIME_MANAGER._platform_key("darwin", "aarch64") == "macos-arm64"


def test_application_versions_compare_numerically() -> None:
    assert RUNTIME_MANAGER._version_key("0.10.0") > RUNTIME_MANAGER._version_key(
        "0.9.9"
    )


def test_current_application_bridge_is_resolved() -> None:
    assert RUNTIME_MANAGER._studio_bridge() == (
        SCRIPT.parents[1] / "python" / "deepmd_ui" / "bridge.py"
    )


def test_runtime_examples_follow_selected_source(tmp_path: Path) -> None:
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    (source / "examples" / "water").mkdir(parents=True)
    (source / "examples" / "nvnmd").mkdir()
    runtime.mkdir()
    (runtime / "deepmd-ui-examples").mkdir()
    (runtime / "deepmd-ui-examples" / "stale.json").write_text("{}", encoding="utf-8")
    (source / "examples" / "water" / "input.json").write_text("{}", encoding="utf-8")
    (source / "examples" / "nvnmd" / "train.json").write_text("{}", encoding="utf-8")

    RUNTIME_MANAGER._replace_examples(source, runtime)

    assert (runtime / "deepmd-ui-examples" / "water" / "input.json").is_file()
    assert not (runtime / "deepmd-ui-examples" / "stale.json").exists()
    assert not (runtime / "deepmd-ui-examples" / "nvnmd").exists()


def test_application_update_manifest_is_resolved(monkeypatch) -> None:
    manifest = {
        "schema_version": 1,
        "version": "0.2.0",
        "tag": "v0.2.0",
        "assets": {
            "windows-x86_64": {
                "name": "DeePMD-Studio-0.2.0-Setup.exe",
                "bytes": 42,
                "sha256": "a" * 64,
            }
        },
    }
    monkeypatch.setattr(
        RUNTIME_MANAGER,
        "_read_url",
        lambda *args, **kwargs: (json.dumps(manifest).encode(), "manifest"),
    )
    plan = RUNTIME_MANAGER.resolve_application_update(
        "0.1.0",
        "windows",
        "x86_64",
        "https://gh-proxy.com",
    )
    assert plan["update_available"] is True
    assert plan["latest_version"] == "0.2.0"
    assert plan["asset_name"].endswith("Setup.exe")
