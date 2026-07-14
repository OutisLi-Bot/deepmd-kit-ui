# SPDX-License-Identifier: LGPL-3.0-or-later
"""Synchronize the application version used by Node, Rust, and Tauri."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main(version: str) -> None:
    version = version.removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise ValueError(f"Invalid application version: {version}")

    package_path = ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package["version"] = version
    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

    tauri_path = ROOT / "src-tauri" / "tauri.conf.json"
    tauri = json.loads(tauri_path.read_text(encoding="utf-8"))
    tauri["version"] = version
    tauri_path.write_text(json.dumps(tauri, indent=2) + "\n", encoding="utf-8")

    cargo_path = ROOT / "Cargo.toml"
    cargo = cargo_path.read_text(encoding="utf-8")
    cargo = re.sub(
        r'(?m)^(\[workspace\.package\]\s*\nversion = ")[^"]+(".*)$',
        rf"\g<1>{version}\g<2>",
        cargo,
        count=1,
    )
    cargo_path.write_text(cargo, encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} VERSION")
    main(sys.argv[1])
