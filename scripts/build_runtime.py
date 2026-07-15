# SPDX-License-Identifier: LGPL-3.0-or-later
"""Build the relocatable Python runtime bundled with DeePMD Studio."""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import (
    Path,
)
from typing import (
    Final,
    TYPE_CHECKING,
)

if TYPE_CHECKING:
    from collections.abc import (
        Sequence,
    )

LOGGER = logging.getLogger("deepmd-studio-runtime")

CORE_REQUIREMENTS: Final[tuple[str, ...]] = (
    "pip",
    "setuptools",
    "wheel",
    "torch>=2.12,<2.13",
    "e3nn>=0.5.9",
    "vesin[torch]",
    "jax>=0.6.2",
    "flax>=0.10.0",
    "orbax-checkpoint",
    "tensorboard",
)

WINDOWS_TRITON_REQUIREMENT: Final[str] = "triton-windows>=3.7,<3.8"

FULL_REQUIREMENTS: Final[tuple[str, ...]] = (
    "ase>=3.23.0",
    "dpdata>=0.2.7",
    "rdkit",
    "scikit-learn",
)


def normalize_platform(value: str | None = None) -> str:
    """Return a runtime platform name used by the build matrix.

    Parameters
    ----------
    value : str or None, optional
        Explicit platform name. The current host is detected when omitted.

    Returns
    -------
    str
        One of ``windows``, ``linux``, or ``macos``.
    """
    if value:
        return value
    return {
        "Windows": "windows",
        "Linux": "linux",
        "Darwin": "macos",
    }[platform.system()]


def runtime_requirements(
    profile: str,
    target_platform: str,
    accelerator: str,
) -> list[str]:
    """Build the package requirement list for one runtime profile.

    Parameters
    ----------
    profile : str
        ``core`` installs the supported backends. ``full`` also installs the
        Python dependencies used by DPA-Adapt.
    target_platform : str
        Target operating system.
    accelerator : str
        PyTorch wheel backend such as ``cpu`` or ``cu130``.

    Returns
    -------
    list[str]
        Requirements passed to ``uv pip install``.
    """
    requirements = list(CORE_REQUIREMENTS)
    if profile == "full":
        requirements.extend(FULL_REQUIREMENTS)
    if target_platform == "linux" and accelerator.startswith("cu"):
        requirements[requirements.index("jax>=0.6.2")] = "jax[cuda13]>=0.6.2"
    if target_platform == "windows" and accelerator.startswith("cu"):
        requirements.append(WINDOWS_TRITON_REQUIREMENT)
    return requirements


def runtime_executable(runtime_root: Path, target_platform: str) -> Path:
    """Return the Python executable inside a copied runtime.

    Parameters
    ----------
    runtime_root : pathlib.Path
        Root of the relocatable runtime.
    target_platform : str
        Target operating system.

    Returns
    -------
    pathlib.Path
        Python executable path.
    """
    if target_platform == "windows":
        return runtime_root / "python.exe"
    return runtime_root / "bin" / "python3"


def site_packages_directory(runtime_root: Path, target_platform: str) -> Path:
    """Return the site-packages directory inside a relocatable runtime."""
    if target_platform == "windows":
        return runtime_root / "Lib" / "site-packages"
    candidates = list(runtime_root.glob("lib/python*/site-packages"))
    if len(candidates) != 1:
        raise RuntimeError(
            f"Expected one site-packages directory below {runtime_root}, "
            f"found {len(candidates)}"
        )
    return candidates[0]


def install_ui_bridge(runtime_root: Path, target_platform: str) -> None:
    """Install the UI-owned Python bridge into the private runtime."""
    source = Path(__file__).resolve().parents[1] / "python" / "deepmd_ui"
    if not (source / "bridge.py").is_file():
        raise FileNotFoundError(f"DeePMD UI bridge source is missing: {source}")
    destination = site_packages_directory(runtime_root, target_platform) / "deepmd_ui"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(
        source,
        destination,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )


def run(
    arguments: Sequence[str | Path],
    *,
    environment: dict[str, str] | None = None,
    working_directory: Path | None = None,
    capture: bool = False,
) -> str:
    """Run one build command and fail with its original exit status.

    Parameters
    ----------
    arguments : Sequence[str or pathlib.Path]
        Executable and argument vector.
    environment : dict[str, str] or None, optional
        Complete child-process environment.
    working_directory : pathlib.Path or None, optional
        Child-process working directory.
    capture : bool, optional
        Capture and return standard output.

    Returns
    -------
    str
        Captured standard output, or an empty string.
    """
    command = [str(argument) for argument in arguments]
    LOGGER.info("Running %s", subprocess.list2cmdline(command))
    result = subprocess.run(
        command,
        check=True,
        cwd=working_directory,
        env=environment,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def install_managed_python(
    uv: Path,
    python_version: str,
    installation_directory: Path,
) -> Path:
    """Download a python-build-standalone runtime through uv.

    Parameters
    ----------
    uv : pathlib.Path
        ``uv`` executable.
    python_version : str
        CPython request such as ``3.11``.
    installation_directory : pathlib.Path
        Temporary uv-managed Python directory.

    Returns
    -------
    pathlib.Path
        Root directory of the resolved CPython installation.
    """
    install_command = [
        uv,
        "python",
        "install",
        "--install-dir",
        installation_directory,
        "--no-bin",
        "--reinstall",
    ]
    if os.name == "nt":
        install_command.append("--no-registry")
    install_command.append(python_version)
    run(install_command)

    environment = os.environ.copy()
    environment["UV_PYTHON_INSTALL_DIR"] = str(installation_directory)
    executable = Path(
        run(
            [
                uv,
                "python",
                "find",
                "--no-project",
                "--managed-python",
                "--resolve-links",
                python_version,
            ],
            environment=environment,
            capture=True,
        )
    )
    if not executable.is_file():
        raise FileNotFoundError(
            f"uv returned a missing Python executable: {executable}"
        )
    return executable.parent if os.name == "nt" else executable.parent.parent


def replace_runtime(source: Path, output: Path) -> None:
    """Copy a managed CPython installation into the bundle resource path.

    Parameters
    ----------
    source : pathlib.Path
        Managed CPython root.
    output : pathlib.Path
        Final runtime directory.
    """
    output = output.resolve()
    if output == Path(output.anchor) or output == Path.cwd().resolve():
        raise ValueError(f"Refusing to replace unsafe output path: {output}")
    readme = (
        (output / "README.md").read_text(encoding="utf-8") if output.is_dir() else None
    )
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(source.resolve(), output, symlinks=True)
    if readme is not None:
        (output / "README.md").write_text(readme, encoding="utf-8")


def prune_development_files(runtime_root: Path, target_platform: str) -> None:
    """Remove tests and build-time files not needed at runtime.

    Parameters
    ----------
    runtime_root : pathlib.Path
        Relocatable runtime root.
    target_platform : str
        Target operating system.
    """

    def remove_tree(candidate: Path) -> None:
        candidate_string = str(candidate)
        if (
            target_platform == "windows"
            and os.name == "nt"
            and not candidate_string.startswith("\\\\?\\")
        ):
            candidate = Path("\\\\?\\" + str(candidate.resolve()))
        if candidate.is_symlink():
            candidate.unlink()
        elif candidate.is_dir():
            shutil.rmtree(candidate)

    candidates: list[Path] = []
    if target_platform == "windows":
        # triton-windows compiles its CUDA driver helper on first use. Keep
        # Python.h and python3XX.lib so the embedded compiler can link that
        # extension without a system Python or Visual Studio installation.
        site_packages_directories = [runtime_root / "Lib" / "site-packages"]
    else:
        candidates.append(runtime_root / "include")
        candidates.extend(runtime_root.glob("lib/python*/config-*"))
        candidates.append(runtime_root / "lib" / "pkgconfig")
        site_packages_directories = list(runtime_root.glob("lib/python*/site-packages"))

    for site_packages in site_packages_directories:
        candidates.extend(
            [
                site_packages
                / "orbax"
                / "checkpoint"
                / "experimental"
                / "v1"
                / "_src"
                / "testing",
                site_packages / "torch" / "include",
                site_packages / "torch" / "share" / "cmake",
                site_packages / "jaxlib" / "include",
                site_packages / "numpy" / "_core" / "include",
                site_packages / "numpy" / "core" / "include",
            ]
        )

    for candidate in candidates:
        remove_tree(candidate)

    removable_suffixes = {".a", ".lib", ".pdb"}
    for site_packages in site_packages_directories:
        if not site_packages.is_dir():
            continue
        walk_root = site_packages
        if target_platform == "windows" and os.name == "nt":
            walk_root = Path("\\\\?\\" + str(site_packages.resolve()))
        for directory, subdirectories, files in os.walk(walk_root, topdown=True):
            test_directories = {
                name
                for name in subdirectories
                if name.lower() in {"test", "tests", "__pycache__"}
            }
            for name in test_directories:
                remove_tree(Path(directory) / name)
            subdirectories[:] = [
                name for name in subdirectories if name not in test_directories
            ]
            for name in files:
                path = Path(directory) / name
                relative_parts = path.relative_to(walk_root).parts
                belongs_to_triton = (
                    bool(relative_parts) and relative_parts[0] == "triton"
                )
                if path.suffix.lower() in removable_suffixes and not belongs_to_triton:
                    path.unlink()


def write_manifest(
    python: Path,
    output: Path,
    *,
    profile: str,
    target_platform: str,
    accelerator: str,
    wheel: Path,
    repository: str,
    source_ref: str,
    source_commit: str,
) -> None:
    """Write a machine-readable inventory next to the bundled runtime.

    Parameters
    ----------
    python : pathlib.Path
        Runtime Python executable.
    output : pathlib.Path
        Runtime root.
    profile : str
        Runtime dependency profile.
    target_platform : str
        Target operating system.
    accelerator : str
        Requested PyTorch wheel backend.
    wheel : pathlib.Path
        Installed local DeePMD-kit wheel.
    """
    inventory_script = """
import importlib.metadata as metadata
import json
import platform

packages = {}
for name in [
    "deepmd-kit", "torch", "jax", "jaxlib", "flax", "orbax-checkpoint",
    "dpdata", "ase", "scikit-learn", "rdkit", "e3nn", "vesin",
    "triton-windows",
]:
    try:
        packages[name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        pass
print(json.dumps({"python": platform.python_version(), "packages": packages}))
"""
    inventory = json.loads(run([python, "-c", inventory_script], capture=True))
    manifest = {
        "schema_version": 2,
        "profile": profile,
        "platform": target_platform,
        "accelerator": accelerator,
        "source_wheel": wheel.name,
        "deepmd_source": {
            "repository": repository,
            "ref": source_ref,
            "commit": source_commit,
        },
        **inventory,
    }
    (output / "deepmd-ui-runtime.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def verify_runtime(
    python: Path,
    profile: str,
    target_platform: str,
    accelerator: str,
) -> None:
    """Smoke-test the packaged CLI and every bundled backend.

    Parameters
    ----------
    python : pathlib.Path
        Runtime Python executable.
    profile : str
        Runtime dependency profile.
    target_platform : str
        Target operating system.
    accelerator : str
        Requested PyTorch wheel backend.
    """
    imports = [
        "deepmd.pt",
        "deepmd.pt_expt",
        "deepmd.jax",
        "e3nn",
        "vesin",
        "vesin.torch",
    ]
    if profile == "full":
        imports.append("dpa_adapt")
    verification_directory = python.parent
    run(
        [python, "-I", "-c", ";".join(f"import {name}" for name in imports)],
        working_directory=verification_directory,
    )
    run(
        [python, "-I", "-m", "deepmd", "--help"],
        working_directory=verification_directory,
    )
    if target_platform == "windows" and accelerator.startswith("cu"):
        run(
            [
                python,
                "-I",
                "-c",
                (
                    "import torch, triton; "
                    "assert torch.version.cuda is not None, torch.__version__; "
                    "assert triton.__version__.startswith('3.7.'), triton.__version__"
                ),
            ],
            working_directory=verification_directory,
        )
    report = json.loads(
        run(
            [python, "-I", "-m", "deepmd_ui.bridge", "doctor"],
            working_directory=verification_directory,
            capture=True,
        )
    )
    available = {
        backend["id"] for backend in report["backends"] if backend["available"]
    }
    required = {"pytorch", "pytorch-exportable", "jax", "dpmodel"}
    if missing := required - available:
        raise RuntimeError(f"Bundled backend validation failed: {sorted(missing)}")


def build_runtime(namespace: argparse.Namespace) -> None:
    """Build and verify a DeePMD Studio runtime from parsed arguments.

    Parameters
    ----------
    namespace : argparse.Namespace
        Parsed command-line options.
    """
    target_platform = normalize_platform(namespace.platform)
    wheel = namespace.wheel.resolve()
    output = namespace.output.resolve()
    if not wheel.is_file() or wheel.suffix != ".whl":
        raise FileNotFoundError(f"DeePMD-kit wheel does not exist: {wheel}")
    if target_platform == "macos" and namespace.accelerator != "cpu":
        raise ValueError("macOS runtime builds currently require --accelerator cpu")

    with tempfile.TemporaryDirectory(prefix="deepmd-studio-python-") as temporary:
        managed_root = install_managed_python(
            namespace.uv,
            namespace.python_version,
            Path(temporary),
        )
        replace_runtime(managed_root, output)

    python = runtime_executable(output, target_platform)
    if not python.is_file():
        raise FileNotFoundError(f"Copied runtime has no Python executable: {python}")
    requirements = runtime_requirements(
        namespace.profile,
        target_platform,
        namespace.accelerator,
    )
    install_command: list[str | Path] = [
        namespace.uv,
        "pip",
        "install",
        "--python",
        python,
        "--break-system-packages",
        "--no-cache",
        wheel,
        *requirements,
        "--torch-backend",
        namespace.accelerator,
    ]
    run(install_command)
    install_ui_bridge(output, target_platform)
    write_manifest(
        python,
        output,
        profile=namespace.profile,
        target_platform=target_platform,
        accelerator=namespace.accelerator,
        wheel=wheel,
        repository=namespace.deepmd_repository,
        source_ref=namespace.deepmd_ref,
        source_commit=namespace.deepmd_commit,
    )
    verify_runtime(
        python,
        namespace.profile,
        target_platform,
        namespace.accelerator,
    )
    prune_development_files(output, target_platform)
    size = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    LOGGER.info("Runtime ready at %s (%.2f GiB)", output, size / 1024**3)


def build_parser() -> argparse.ArgumentParser:
    """Create the runtime-builder argument parser.

    Returns
    -------
    argparse.ArgumentParser
        Configured parser.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).parents[1] / "src-tauri" / "resources" / "runtime",
    )
    parser.add_argument("--uv", type=Path, default=Path("uv"))
    parser.add_argument("--python-version", default="3.11")
    parser.add_argument(
        "--deepmd-repository",
        default=os.environ.get("DEEPMD_REPOSITORY", ""),
    )
    parser.add_argument("--deepmd-ref", default=os.environ.get("DEEPMD_REF", ""))
    parser.add_argument(
        "--deepmd-commit",
        default=os.environ.get("DEEPMD_COMMIT", ""),
    )
    parser.add_argument("--profile", choices=("core", "full"), default="core")
    parser.add_argument("--platform", choices=("windows", "linux", "macos"))
    parser.add_argument(
        "--accelerator",
        choices=("cpu", "auto", "cu128", "cu130"),
        default="cpu",
    )
    return parser


def main(arguments: Sequence[str] | None = None) -> None:
    """Build a relocatable runtime for one host platform.

    Parameters
    ----------
    arguments : Sequence[str] or None, optional
        Command-line arguments. ``sys.argv`` is used when omitted.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    build_runtime(build_parser().parse_args(arguments))


if __name__ == "__main__":
    main()
