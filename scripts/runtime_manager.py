# SPDX-License-Identifier: LGPL-3.0-or-later
"""Resolve and atomically stage application-owned DeePMD Python runtimes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
import zipfile
from pathlib import Path
from typing import Any

OFFICIAL_REPOSITORY = "https://github.com/deepmodeling/deepmd-kit.git"
OFFICIAL_SLUG = "deepmodeling/deepmd-kit"
DEFAULT_GITHUB_PROXY = "https://gh-proxy.com"
APPLICATION_REPOSITORY_SLUG = "OutisLi-Bot/deepmd-kit-ui"


def _github_slug(repository: str) -> str:
    value = repository.strip().rstrip("/")
    if value.startswith("git@github.com:"):
        value = value.removeprefix("git@github.com:")
    elif "github.com/" in value:
        value = value.split("github.com/", 1)[1]
    value = value.removesuffix(".git").strip("/")
    parts = value.split("/")
    if len(parts) != 2 or not all(parts):
        raise ValueError("Only GitHub repository URLs in owner/name form are supported")
    return "/".join(parts)


def _proxied(url: str, proxy: str) -> str:
    prefix = proxy.strip()
    if not prefix:
        return url
    if "{url}" in prefix:
        return prefix.replace("{url}", urllib.parse.quote(url, safe=":/?=&"))
    return f"{prefix.rstrip('/')}/{url}"


def _request_json(url: str, proxy: str) -> dict[str, Any]:
    data, _ = _read_url(
        url,
        proxy,
        timeout=60,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    payload = json.loads(data)
    if not isinstance(payload, dict):
        raise RuntimeError("GitHub returned an unexpected response")
    return payload


def _candidate_urls(url: str, proxy: str) -> list[str]:
    proxied = _proxied(url, proxy)
    return [proxied, url] if proxied != url else [url]


def _read_url(
    url: str,
    proxy: str,
    *,
    timeout: int,
    headers: dict[str, str] | None = None,
) -> tuple[bytes, str]:
    errors: list[Exception] = []
    for candidate in _candidate_urls(url, proxy):
        request = urllib.request.Request(
            candidate,
            headers={
                "User-Agent": "deepmd-kit-ui-runtime-manager",
                **(headers or {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(), response.geturl()
        except Exception as error:  # pragma: no cover - depends on the network
            errors.append(error)
    raise RuntimeError(f"Unable to download {url}: {errors[-1]}") from errors[-1]


def _latest_release_ref(slug: str, proxy: str) -> str:
    url = f"https://github.com/{slug}/releases/latest"
    data, final_url = _read_url(url, proxy, timeout=60)
    candidates = (urllib.parse.unquote(final_url), data.decode("utf-8", "replace"))
    pattern = re.compile(r"/releases/tag/([^/?#\"']+)")
    for candidate in candidates:
        if match := pattern.search(candidate):
            return urllib.parse.unquote(match.group(1))
    raise RuntimeError("GitHub's latest release page did not expose a tag")


def _commit_from_atom(slug: str, source_ref: str, proxy: str) -> str:
    encoded_ref = urllib.parse.quote(source_ref, safe="")
    data, _ = _read_url(
        f"https://github.com/{slug}/commits/{encoded_ref}.atom",
        proxy,
        timeout=60,
    )
    root = ElementTree.fromstring(data)
    entry = root.find("{http://www.w3.org/2005/Atom}entry")
    identifier = (
        None if entry is None else entry.findtext("{http://www.w3.org/2005/Atom}id")
    )
    commit = (identifier or "").rsplit("/", 1)[-1]
    if not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
        raise RuntimeError("GitHub's commit feed did not expose a full commit SHA")
    return commit.lower()


def resolve_source(
    channel: str,
    repository: str,
    source_ref: str,
    proxy: str,
) -> dict[str, Any]:
    """Resolve stable, beta, or custom settings to one immutable commit."""
    if channel == "stable":
        slug = OFFICIAL_SLUG
        repository = OFFICIAL_REPOSITORY
        try:
            source_ref = _latest_release_ref(slug, proxy)
        except Exception:
            release = _request_json(
                f"https://api.github.com/repos/{slug}/releases/latest",
                proxy,
            )
            source_ref = str(release["tag_name"])
        display_version = source_ref
    elif channel == "beta":
        slug = OFFICIAL_SLUG
        repository = OFFICIAL_REPOSITORY
        source_ref = "master"
        display_version = "master"
    elif channel == "custom":
        slug = _github_slug(repository)
        source_ref = source_ref.strip() or "master"
        display_version = source_ref
    else:
        raise ValueError(f"Unsupported runtime channel: {channel}")

    try:
        commit = _commit_from_atom(slug, source_ref, proxy)
    except Exception:
        encoded_ref = urllib.parse.quote(source_ref, safe="")
        commit_payload = _request_json(
            f"https://api.github.com/repos/{slug}/commits/{encoded_ref}",
            proxy,
        )
        commit = str(commit_payload["sha"])
    archive = f"https://github.com/{slug}/archive/{commit}.zip"
    return {
        "schema_version": 1,
        "channel": channel,
        "repository": repository,
        "repository_slug": slug,
        "requested_ref": source_ref,
        "resolved_ref": source_ref,
        "commit": commit,
        "short_commit": commit[:12],
        "display_version": f"{display_version}@{commit[:12]}",
        "archive_url": archive,
        "github_proxy": proxy.strip(),
        "update_mode": "python_overlay",
    }


def _download(url: str, destination: Path, proxy: str) -> None:
    errors: list[Exception] = []
    for candidate in _candidate_urls(url, proxy):
        request = urllib.request.Request(
            candidate,
            headers={"User-Agent": "deepmd-kit-ui-runtime-manager"},
        )
        try:
            with (
                urllib.request.urlopen(request, timeout=180) as response,
                destination.open("wb") as output,
            ):
                shutil.copyfileobj(response, output, length=1024 * 1024)
            return
        except Exception as error:  # pragma: no cover - depends on the network
            errors.append(error)
            destination.unlink(missing_ok=True)
    raise RuntimeError(f"Unable to download {url}: {errors[-1]}") from errors[-1]


def _isolated_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in (
        "CONDA_PREFIX",
        "CONDA_DEFAULT_ENV",
        "PYTHONHOME",
        "PYTHONPATH",
    ):
        environment.pop(name, None)
    environment.update(
        {
            "DPMD_STUDIO_BUNDLED": "1",
            "DPMD_UI_ISOLATED": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    return environment


def _runtime_python(runtime: Path) -> Path:
    return runtime / ("python.exe" if os.name == "nt" else "bin/python3")


def _studio_bridge() -> Path | None:
    """Resolve the bridge shipped by the current application version."""
    resource_root = Path(__file__).resolve().parent.parent
    candidates = (
        resource_root / "bridge" / "deepmd_ui_bridge.py",
        resource_root / "python" / "deepmd_ui" / "bridge.py",
    )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def _replace_examples(source_root: Path, runtime: Path) -> None:
    """Replace runtime examples with the selected DeePMD source revision.

    Parameters
    ----------
    source_root : pathlib.Path
        Extracted DeePMD-kit source root.
    runtime : pathlib.Path
        Staging application runtime that will become active atomically.
    """
    source = source_root / "examples"
    destination = runtime / "deepmd-ui-examples"
    if destination.exists():
        shutil.rmtree(destination)
    if not source.is_dir():
        return

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored = {name for name in names if name in {"__pycache__", ".git"}}
        if Path(directory).resolve() == source.resolve():
            ignored.update(name for name in names if name in {"nvnmd", ".gitignore"})
        ignored.update(name for name in names if name.endswith((".pyc", ".pyo")))
        return ignored

    shutil.copytree(source, destination, ignore=ignore)


def rebuild_runtime(base: Path, output: Path, plan: dict[str, Any]) -> dict[str, Any]:
    """Clone a runtime privately, overlay one source commit, and verify it."""
    base = base.resolve()
    output = output.resolve()
    if not _runtime_python(base).is_file():
        raise FileNotFoundError(f"Base runtime is incomplete: {base}")
    if output.exists():
        raise FileExistsError(f"Staging runtime already exists: {output}")

    shutil.copytree(base, output)
    with tempfile.TemporaryDirectory(prefix="deepmd-ui-source-") as temporary:
        temporary_root = Path(temporary)
        archive = temporary_root / "source.zip"
        _download(
            str(plan["archive_url"]),
            archive,
            str(plan.get("github_proxy", "")),
        )
        with zipfile.ZipFile(archive) as source_zip:
            source_zip.extractall(temporary_root / "source")
        roots = [
            path for path in (temporary_root / "source").iterdir() if path.is_dir()
        ]
        if len(roots) != 1 or not (roots[0] / "deepmd" / "__init__.py").is_file():
            raise RuntimeError(
                "Downloaded repository does not contain a DeePMD Python package"
            )
        source_root = roots[0]

        site_packages = (
            output / "Lib" / "site-packages"
            if os.name == "nt"
            else next(output.glob("lib/python*/site-packages"))
        )
        deepmd_target = site_packages / "deepmd"
        native_library = deepmd_target / "lib"
        saved_native_library = temporary_root / "native-deepmd-lib"
        if native_library.is_dir():
            shutil.copytree(native_library, saved_native_library)
        if deepmd_target.exists():
            shutil.rmtree(deepmd_target)
        shutil.copytree(
            source_root / "deepmd",
            deepmd_target,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        if saved_native_library.is_dir():
            shutil.copytree(
                saved_native_library,
                deepmd_target / "lib",
                dirs_exist_ok=True,
            )
        (deepmd_target / "_version.py").write_text(
            f"version = {str(plan['display_version'])!r}\n",
            encoding="utf-8",
        )
        dpa_target = site_packages / "dpa_adapt"
        if dpa_target.exists():
            shutil.rmtree(dpa_target)
        if (source_root / "dpa_adapt").is_dir():
            shutil.copytree(
                source_root / "dpa_adapt",
                dpa_target,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )

        _replace_examples(source_root, output)

        # The bridge is Studio UI protocol, not DeePMD runtime state. Keep a
        # compatibility copy in managed runtimes, while desktop/TUI launches
        # the application-owned copy directly.
        if bridge_source := _studio_bridge():
            bridge_target = site_packages / "deepmd_ui"
            bridge_target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bridge_source, bridge_target / "bridge.py")

    manifest_path = output / "deepmd-ui-runtime.json"
    manifest = (
        json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest_path.is_file()
        else {"schema_version": 2}
    )
    native_base = manifest.get("native_base") or manifest.get("deepmd_source")
    manifest.update(
        {
            "runtime_channel": plan["channel"],
            "update_mode": "python_overlay",
            "native_base": native_base,
            "deepmd_source": {
                "repository": plan["repository"],
                "ref": plan["resolved_ref"],
                "commit": plan["commit"],
            },
        }
    )
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    python = _runtime_python(output)
    verification = (
        "import deepmd.pt, deepmd.pt_expt, deepmd.jax, deepmd_ui.bridge; "
        "import torch; assert torch.tensor([1., 2.]).sum().item() == 3.0"
    )
    subprocess.run(
        [python, "-I", "-c", verification],
        check=True,
        cwd=output,
        env=_isolated_environment(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    doctor = subprocess.run(
        [python, "-I", "-m", "deepmd_ui.bridge", "doctor"],
        check=True,
        cwd=output,
        env=_isolated_environment(),
        text=True,
        stdout=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return {
        "schema_version": 1,
        "runtime": str(output),
        "plan": plan,
        "doctor": json.loads(doctor.stdout),
        "restart_required": True,
    }


def _version_key(version: str) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", version.split("+", 1)[0].split("-", 1)[0])
    return tuple(int(number) for number in numbers) or (0,)


def _platform_key(target_platform: str, architecture: str) -> str:
    platform_aliases = {
        "win32": "windows",
        "windows": "windows",
        "darwin": "macos",
        "macos": "macos",
        "linux": "linux",
    }
    architecture_aliases = {
        "amd64": "x86_64",
        "x86_64": "x86_64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }
    platform_name = platform_aliases.get(target_platform.lower())
    architecture_name = architecture_aliases.get(architecture.lower())
    if not platform_name or not architecture_name:
        raise ValueError(
            f"Unsupported application update target: {target_platform}/{architecture}"
        )
    return f"{platform_name}-{architecture_name}"


def resolve_application_update(
    current_version: str,
    target_platform: str,
    architecture: str,
    proxy: str,
    repository_slug: str = APPLICATION_REPOSITORY_SLUG,
) -> dict[str, Any]:
    """Resolve the latest signed-off UI release for this operating system."""
    manifest_url = (
        f"https://github.com/{repository_slug}/releases/latest/download/"
        "update-manifest.json"
    )
    data, _ = _read_url(manifest_url, proxy, timeout=60)
    manifest = json.loads(data)
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise RuntimeError("The application update manifest is invalid")
    platform_key = _platform_key(target_platform, architecture)
    assets = manifest.get("assets")
    if not isinstance(assets, dict) or platform_key not in assets:
        raise RuntimeError(f"No application update is available for {platform_key}")
    asset = assets[platform_key]
    if not isinstance(asset, dict):
        raise RuntimeError(f"The {platform_key} update asset is invalid")
    latest_version = str(manifest["version"])
    tag = str(manifest["tag"])
    asset_name = Path(str(asset["name"])).name
    sha256 = str(asset["sha256"]).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise RuntimeError("The application update SHA-256 is invalid")
    return {
        "schema_version": 1,
        "repository_slug": repository_slug,
        "current_version": current_version,
        "latest_version": latest_version,
        "tag": tag,
        "update_available": _version_key(latest_version)
        > _version_key(current_version),
        "platform_key": platform_key,
        "asset_name": asset_name,
        "asset_url": (
            f"https://github.com/{repository_slug}/releases/download/"
            f"{urllib.parse.quote(tag, safe='')}/"
            f"{urllib.parse.quote(asset_name)}"
        ),
        "sha256": sha256,
        "bytes": int(asset["bytes"]),
        "github_proxy": proxy.strip(),
    }


def download_application_update(
    output: Path,
    plan: dict[str, Any],
) -> dict[str, Any]:
    """Download one immutable installer and verify its release-manifest hash."""
    if not plan.get("update_available"):
        raise RuntimeError("DeePMD Studio is already up to date")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    asset_name = Path(str(plan["asset_name"])).name
    if asset_name != str(plan["asset_name"]):
        raise RuntimeError("Unsafe application update asset name")
    destination = output / asset_name
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    _download(
        str(plan["asset_url"]),
        partial,
        str(plan.get("github_proxy", "")),
    )
    digest = hashlib.sha256()
    with partial.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    actual_sha256 = digest.hexdigest()
    if actual_sha256 != str(plan["sha256"]).lower():
        partial.unlink(missing_ok=True)
        raise RuntimeError(
            f"Application update hash mismatch: expected {plan['sha256']}, "
            f"received {actual_sha256}"
        )
    partial.replace(destination)
    return {
        "schema_version": 1,
        "path": str(destination),
        "sha256": actual_sha256,
        "bytes": destination.stat().st_size,
        "plan": plan,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    resolve = subparsers.add_parser("resolve")
    resolve.add_argument(
        "--channel", choices=("stable", "beta", "custom"), required=True
    )
    resolve.add_argument("--repository", default=OFFICIAL_REPOSITORY)
    resolve.add_argument("--ref", default="master")
    resolve.add_argument("--github-proxy", default=DEFAULT_GITHUB_PROXY)

    rebuild = subparsers.add_parser("rebuild")
    rebuild.add_argument("--base", type=Path, required=True)
    rebuild.add_argument("--output", type=Path, required=True)
    rebuild.add_argument("--plan-json", required=True)

    app_resolve = subparsers.add_parser("app-resolve")
    app_resolve.add_argument("--current-version", required=True)
    app_resolve.add_argument("--platform", required=True)
    app_resolve.add_argument("--arch", required=True)
    app_resolve.add_argument(
        "--repository-slug",
        default=APPLICATION_REPOSITORY_SLUG,
    )
    app_resolve.add_argument("--github-proxy", default=DEFAULT_GITHUB_PROXY)

    app_download = subparsers.add_parser("app-download")
    app_download.add_argument("--output", type=Path, required=True)
    app_download.add_argument("--plan-json", required=True)
    return parser


def main(arguments: list[str] | None = None) -> None:
    namespace = _parser().parse_args(arguments)
    if namespace.command == "resolve":
        payload = resolve_source(
            namespace.channel,
            namespace.repository,
            namespace.ref,
            namespace.github_proxy,
        )
    elif namespace.command == "rebuild":
        payload = rebuild_runtime(
            namespace.base,
            namespace.output,
            json.loads(namespace.plan_json),
        )
    elif namespace.command == "app-resolve":
        payload = resolve_application_update(
            namespace.current_version,
            namespace.platform,
            namespace.arch,
            namespace.github_proxy,
            namespace.repository_slug,
        )
    else:
        payload = download_application_update(
            namespace.output,
            json.loads(namespace.plan_json),
        )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
