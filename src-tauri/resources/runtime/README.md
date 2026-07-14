<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# Bundled DeepMD runtime

`desktop/scripts/build_runtime.py` replaces this placeholder in release jobs
with an isolated, relocatable CPython runtime. It installs the wheel built from
the same checkout together with PyTorch, PyTorch Exportable, JAX, DPModel,
DPA-Adapt, and their runtime dependencies. LAMMPS and TensorFlow are not part of
the desktop profile.

Development builds use `DPMD_STUDIO_PYTHON` or the active Conda environment.
