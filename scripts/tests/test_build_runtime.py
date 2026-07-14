# SPDX-License-Identifier: LGPL-3.0-or-later
"""Unit tests for the relocatable runtime builder."""

from __future__ import annotations

import importlib.util
from pathlib import (
    Path,
)

SCRIPT = Path(__file__).parents[1] / "build_runtime.py"
SPEC = importlib.util.spec_from_file_location("build_runtime", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
BUILD_RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD_RUNTIME)


def test_cuda_linux_selects_cuda_jax() -> None:
    requirements = BUILD_RUNTIME.runtime_requirements("full", "linux", "cu130")
    assert "jax[cuda13]>=0.6.2" in requirements
    assert "scikit-learn" in requirements


def test_windows_core_keeps_portable_jax() -> None:
    requirements = BUILD_RUNTIME.runtime_requirements("core", "windows", "cu130")
    assert "jax>=0.6.2" in requirements
    assert "jax[cuda13]>=0.6.2" not in requirements
    assert "triton-windows>=3.7,<3.8" in requirements
    assert "e3nn>=0.5.9" in requirements
    assert "vesin[torch]" in requirements
    assert "scikit-learn" not in requirements


def test_windows_cpu_runtime_does_not_install_triton() -> None:
    requirements = BUILD_RUNTIME.runtime_requirements("core", "windows", "cpu")
    assert "triton-windows>=3.7,<3.8" not in requirements


def test_runtime_executable_uses_platform_layout(tmp_path: Path) -> None:
    assert BUILD_RUNTIME.runtime_executable(tmp_path, "windows") == (
        tmp_path / "python.exe"
    )
    assert BUILD_RUNTIME.runtime_executable(tmp_path, "linux") == (
        tmp_path / "bin" / "python3"
    )


def test_ui_bridge_is_copied_into_private_runtime(tmp_path: Path) -> None:
    site_packages = tmp_path / "Lib" / "site-packages"
    site_packages.mkdir(parents=True)

    BUILD_RUNTIME.install_ui_bridge(tmp_path, "windows")

    assert (site_packages / "deepmd_ui" / "__init__.py").is_file()
    assert (site_packages / "deepmd_ui" / "bridge.py").is_file()


def test_prune_removes_tests_and_build_files(tmp_path: Path) -> None:
    site_packages = tmp_path / "Lib" / "site-packages"
    removable = [
        site_packages / "package" / "tests" / "test_feature.py",
        site_packages / "package" / "__pycache__" / "feature.pyc",
        site_packages / "torch" / "include" / "torch.h",
        site_packages / "torch" / "lib" / "torch.lib",
    ]
    preserved = [
        site_packages / "numpy" / "testing" / "__init__.py",
        site_packages / "triton" / "backends" / "nvidia" / "lib" / "x64" / "cuda.lib",
        site_packages / "triton" / "runtime" / "tcc" / "lib" / "libtcc1.a",
        tmp_path / "Include" / "Python.h",
        tmp_path / "libs" / "python311.lib",
    ]
    for path in [*removable, *preserved]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("placeholder", encoding="utf-8")

    BUILD_RUNTIME.prune_development_files(tmp_path, "windows")

    assert all(not path.exists() for path in removable)
    assert all(path.is_file() for path in preserved)
