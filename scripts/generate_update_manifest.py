# SPDX-License-Identifier: LGPL-3.0-or-later
"""Generate the immutable installer inventory consumed by in-app updates."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _target(path: Path) -> tuple[str, int] | None:
    text = path.as_posix().lower()
    name = path.name.lower()
    if path.suffix.lower() == ".exe" and "setup" in name and "windows" in name:
        return "windows-x86_64", 100
    if path.suffix.lower() == ".dmg":
        if "aarch64" in text or "arm64" in text:
            return "macos-arm64", 100
        if "x86_64" in text or "x64" in text:
            return "macos-x86_64", 100
    if name.endswith(".appimage") and "x86_64" in text:
        return "linux-x86_64", 100
    if path.suffix.lower() == ".deb" and "x86_64" in text:
        return "linux-x86_64", 50
    return None


def generate(root: Path, version: str, tag: str) -> dict[str, object]:
    selected: dict[str, tuple[int, Path]] = {}
    for path in root.rglob("*"):
        if not path.is_file() or not (target := _target(path)):
            continue
        key, priority = target
        if key not in selected or priority > selected[key][0]:
            selected[key] = (priority, path)
    required = {"windows-x86_64", "macos-arm64", "macos-x86_64", "linux-x86_64"}
    if missing := required - selected.keys():
        raise RuntimeError(f"Missing application update assets: {sorted(missing)}")
    assets = {}
    for key, (_, path) in sorted(selected.items()):
        assets[key] = {
            "name": path.name,
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
    return {
        "schema_version": 1,
        "version": version.removeprefix("v"),
        "tag": tag,
        "assets": assets,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    namespace = parser.parse_args()
    payload = generate(namespace.root.resolve(), namespace.version, namespace.tag)
    namespace.output.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
