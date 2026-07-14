<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# DeePMD Studio

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

TensorFlow and LAMMPS are deliberately excluded from the current profile.

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
