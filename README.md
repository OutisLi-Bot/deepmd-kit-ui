<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# DeePMD Studio

[![Check](https://github.com/OutisLi-Bot/deepmd-kit-ui/actions/workflows/check.yml/badge.svg)](https://github.com/OutisLi-Bot/deepmd-kit-ui/actions/workflows/check.yml)
[![Build](https://github.com/OutisLi-Bot/deepmd-kit-ui/actions/workflows/build.yml/badge.svg)](https://github.com/OutisLi-Bot/deepmd-kit-ui/actions/workflows/build.yml)

DeePMD Studio is a standalone desktop, terminal, and agent interface for the
DeePMD-kit Python toolchain. It lives in its own `deepmd-kit-ui` repository and
does not discover a local DeePMD checkout, Conda environment, system Python, or
anything on `PATH`.

## What is bundled

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop | Tauri 2, React, TypeScript | Dynamic command forms, diagnostics, updates, tasks, and live logs |
| Process core | Rust, Tokio | Shell-free launch, cancellation, bounded logs, and atomic runtime activation |
| Terminal and agent CLI | Ratatui, `dpstudio` | Keyboard UI plus JSON/JSONL automation protocol |
| Scientific runtime | Relocatable CPython 3.11 | DeePMD-kit, CUDA PyTorch, PT-expt, JAX, and Windows `triton-windows` |

The GUI and TUI use the same application-private runtime. Windows ships CUDA
PyTorch and uses an NVIDIA GPU when one is available, otherwise it falls back
to CPU. macOS uses the bundled PyTorch build and can use MPS/Metal. No system
CUDA toolkit or Conda installation is required.

The machine bridge is owned by the current Studio application rather than by
the mutable scientific runtime. Updating Studio therefore updates workflows
and input-building behavior immediately, even when an older application-managed
runtime remains active.

TensorFlow and LAMMPS are deliberately excluded from the current profile.
Legacy Utilities and NVNMD training are not exposed by Studio.

The interface embeds Maple Mono NF CN Regular and uses it for all UI, form,
documentation, and console text. The font is distributed under the SIL Open
Font License 1.1; its license is included with every packaged application.

## Guided training inputs

The Training workspace has two entry points. Existing JSON, YAML, and YML
files can be selected with the native file picker and are checked by DeePMD's
strict `argcheck` before training. The guided builder loads the complete,
version-matched argument hierarchy and documentation lazily from the bundled
DeePMD runtime, then presents model, dataset, optimizer, loss, validation, and
advanced settings as progressive controls. Generated input is validated again
before it can be saved or run.

The Overview page shows a concise local-machine summary. Its configuration
dialog reports CPU, memory, GPU/VRAM, Windows or macOS details, storage, and the
application-private DeePMD/PyTorch/Triton stack without consulting local Conda.

## DeePMD runtime channels

The Runtime page and `dpstudio runtime` manage source revisions inside the
application:

- **Stable** resolves the latest non-prerelease tag from
  `deepmodeling/deepmd-kit`.
- **Beta** resolves the latest commit on the official `master` branch.
- **Custom** accepts a public GitHub repository plus a branch, tag, or commit.

`https://gh-proxy.com` is the default URL prefix. It can be changed or cleared.
The resolver uses GitHub release redirects and commit feeds before the
rate-limited API, and automatically retries a direct URL if the mirror fails.

An update copies the active runtime to a staging directory, replaces only the
DeePMD Python source while retaining the packaged native/CUDA ABI, validates
PT, PT-expt, JAX, the bridge, and a PyTorch operation, and then atomically
activates it. A failed rebuild leaves the previous runtime untouched. This
Python-only update mode is intentionally not a substitute for rebuilding
LAMMPS or other native integrations; CI-built full runtime bundles can be added
for that later.

## TUI and agent protocol

```text
dpstudio catalog --pretty
dpstudio doctor --pretty
dpstudio tui --backend pytorch --workdir ./examples/water
dpstudio run --backend pytorch --workdir ./examples/water --jsonl train input.json

dpstudio runtime status --pretty
dpstudio runtime check --channel stable --pretty
dpstudio runtime check --channel beta --pretty
dpstudio runtime install --channel custom \
  --repository https://github.com/owner/deepmd-kit.git --ref feature-branch

dpstudio self-update check --pretty
dpstudio self-update install
```

`run --jsonl` emits one JSON object per process event. Arguments are always
passed as an argument vector and never interpolated into a shell command.

## Development

Requirements are Node.js 24+, pnpm 11+, and stable Rust. Frontend development
uses built-in mock data and does not require DeePMD:

```powershell
cd C:\Software\deepmd-kit-ui
pnpm install
pnpm dev
```

Desktop development additionally needs a generated runtime at
`src-tauri/resources/runtime`. Build one from any selected DeePMD wheel:

```powershell
python scripts/build_runtime.py `
  --wheel wheelhouse/deepmd_kit-*.whl `
  --profile core `
  --platform windows `
  --accelerator cu130 `
  --deepmd-repository https://github.com/deepmodeling/deepmd-kit.git `
  --deepmd-ref master `
  --deepmd-commit FULL_COMMIT_SHA
pnpm tauri dev
```

Useful checks:

```text
pnpm test
pnpm build
pytest -q python/tests scripts/tests
cargo fmt --all -- --check
cargo test --workspace
```

## CI, releases, and installers

The `Build DeePMD Studio` workflow accepts a DeePMD repository URL and ref,
checks out the exact commit, builds its wheel, assembles an isolated runtime,
and packages Windows x86-64, macOS Apple Silicon, macOS Intel, and Linux x86-64.
The default source is the official `deepmodeling/deepmd-kit` `master` branch.

Pushing a `v*` tag creates a DeePMD Studio release. CI derives the application
version from the tag and generates `update-manifest.json` with the exact size
and SHA-256 of every platform installer. The GUI and TUI consume that manifest
for application self-updates.

Windows uses Inno Setup 6.5+ and produces one offline
`DeePMD-Studio-<version>-Windows-x64-CUDA13-Setup.exe`. Its runtime is large,
but no adjacent `.bin` files and no network access during installation are
required.
