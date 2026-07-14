# SPDX-License-Identifier: LGPL-3.0-or-later
"""Run a real CUDA Triton kernel against the bundled Studio runtime."""

from __future__ import annotations

import json

import torch
import triton
import triton.language as tl


@triton.jit
def _add_kernel(
    left,
    right,
    output,
    element_count: tl.constexpr,
    block_size: tl.constexpr,
) -> None:
    """Add two contiguous vectors with one masked Triton program."""
    offsets = tl.program_id(axis=0) * block_size + tl.arange(0, block_size)
    mask = offsets < element_count
    result = tl.load(left + offsets, mask=mask) + tl.load(right + offsets, mask=mask)
    tl.store(output + offsets, result, mask=mask)


def main() -> None:
    """Validate CUDA PyTorch, Triton code generation, and DeePMD imports."""
    if torch.version.cuda is None:
        raise RuntimeError(f"PyTorch is not a CUDA build: {torch.__version__}")
    if not torch.cuda.is_available():
        raise RuntimeError("No compatible NVIDIA GPU and driver were detected")

    left = torch.arange(4096, device="cuda", dtype=torch.float32)
    right = torch.full_like(left, 2.0)
    output = torch.empty_like(left)
    block_size = 256
    grid = (triton.cdiv(left.numel(), block_size),)
    _add_kernel[grid](
        left,
        right,
        output,
        left.numel(),
        block_size=block_size,
    )
    torch.cuda.synchronize()
    torch.testing.assert_close(output, left + right)

    import deepmd.pt  # noqa: F401
    import deepmd.pt_expt  # noqa: F401

    print(
        json.dumps(
            {
                "torch": torch.__version__,
                "cuda_runtime": torch.version.cuda,
                "device": torch.cuda.get_device_name(0),
                "triton": triton.__version__,
                "triton_target": str(triton.runtime.driver.active.get_current_target()),
                "kernel_sum": output.sum().item(),
                "deepmd_pt": True,
                "deepmd_pt_expt": True,
            }
        )
    )


if __name__ == "__main__":
    main()
