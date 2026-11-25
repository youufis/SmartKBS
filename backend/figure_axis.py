"""坐标轴公共件：刻度步长选取与数字格式化。

`figure_svg`（函数图像）与 `figure_shapes`（统计图/几何图）原来各写了一份
`_nice_step` 和 `_fmt`，同一个 bug 要改两处 —— 实测就是这么漏的：给统计图加了
"大数值走科学计数"之后，函数图像的 y 轴仍然印出 `1000000000` 这种 10 字符标签，
直接把左边距撑破（2026-11-25 审查发现）。现在两边都从这里取。
"""
from __future__ import annotations

import math

#: 轴标签最多保留的字符数，超过就切科学计数（1000000000 -> 1e+09）
MAX_TICK_CHARS = 7


def nice_step(span: float, target: int = 8) -> float:
    """把跨度换算成"好看"的刻度间隔（1 / 2 / 2.5 / 5 / 10 的十倍数）"""
    raw = span / max(target, 1)
    if raw <= 0:
        return 1.0
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def fmt_tick(v: float, step: float) -> str:
    """刻度数字：常规值按步长定小数位，过大/过小的值切科学计数

    不切的话，物理/化学里 1e8 量级的坐标轴会印出十位数字，把左边距撑破、
    和 y 轴叠在一起。
    """
    if abs(v) < 1e-9:
        return "0"
    if abs(v) >= 10 ** MAX_TICK_CHARS or (abs(v) < 1e-3 and v):
        return "%.3g" % v
    dec = max(0, -int(math.floor(math.log10(step)))) if 0 < step < 1 else 0
    out = ("%%.%df" % dec) % v
    return out.rstrip("0").rstrip(".") if "." in out else out


def ticks(lo: float, hi: float, step: float) -> list[float]:
    """从 lo 到 hi 按 step 取刻度值（含端点，浮点安全）"""
    out: list[float] = []
    v = lo
    guard = 0
    while v <= hi + 1e-9 and guard < 500:
        out.append(v)
        v += step
        guard += 1
    return out
