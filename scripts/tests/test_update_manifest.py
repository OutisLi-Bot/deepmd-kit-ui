# SPDX-License-Identifier: LGPL-3.0-or-later
"""Tests for the cross-platform application update manifest."""

from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "generate_update_manifest.py"
SPEC = importlib.util.spec_from_file_location("generate_update_manifest", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MANIFEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MANIFEST)


def test_manifest_selects_one_installer_per_platform(tmp_path: Path) -> None:
    files = {
        "windows/DeePMD-Studio-0.2.0-Windows-x64-Setup.exe": b"win",
        "aarch64-apple-darwin/DeePMD-Studio-aarch64.dmg": b"arm",
        "x86_64-apple-darwin/DeePMD-Studio-x86_64.dmg": b"intel",
        "x86_64-unknown-linux-gnu/DeePMD-Studio-x86_64.AppImage": b"linux",
    }
    for relative, data in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    manifest = MANIFEST.generate(tmp_path, "0.2.0", "v0.2.0")
    assert set(manifest["assets"]) == {
        "windows-x86_64",
        "macos-arm64",
        "macos-x86_64",
        "linux-x86_64",
    }
    assert manifest["assets"]["windows-x86_64"]["sha256"]
