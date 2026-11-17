#!/usr/bin/env python3
"""verify-pin.py — 验证 NOVA TUI「输入框钉底」字节流（v4）。

ink 每帧结构：[sync-begin][擦除序列: 2K+1A × (高-1) + 2K[G][静态刷入?][动态帧][sync-end]
擦除序列里 `1A` 的个数 + 1 = ink 自己认账的帧高。
不变量：
  1. ink 帧高必须 ≤ rows-1 —— 超过则每次重绘滚一行（creep / 无限上滚 / 跳顶根源）；
  2. cursor-up 完整回放零越顶 —— 越顶即真机「画面跳到最上面」。
静态消息刷入带来的滚动是自然行为，不在断言范围。
"""
import re
import sys
from collections import Counter

LOG = sys.argv[1] if len(sys.argv) > 1 else r"F:/AgentPortable/logs/tui-frames.txt"
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 44

data = open(LOG, encoding="utf8", errors="replace").read()

# ---- 1) ink 帧高分布（擦除序列 1A 次数 + 1；首帧无擦除跳过）----
heights = []
for chunk in data.split("\x1b[?2026h"):
    n_up = len(re.findall(r"\x1b\[2K\x1b\[1A", chunk))
    if n_up or "\x1b[2K\x1b[G" in chunk:
        heights.append(n_up + 1)

# ---- 2) 完整回放：cursor-up 越顶检测 ----
cur, clamps, i, n = 0, 0, 0, len(data)
UP = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z])")
while i < n:
    ch = data[i]
    if ch == "\x1b":
        m = UP.match(data, i)
        if m:
            nums = [int(x) for x in m.group(1).split(";") if x.isdigit()] or [1]
            f = m.group(2)
            if f == "A":
                up = max(1, nums[0])
                if cur - up < 0:
                    clamps += 1
                cur = max(0, cur - up)
            elif f == "B":
                cur = min(ROWS - 1, cur + max(1, nums[0]))
            elif f in "Hf":
                cur = min(ROWS - 1, max(0, (nums[0] if nums[0] > 0 else 1) - 1))
            i = m.end()
            continue
        i += 1
        continue
    if ch == "\n":
        cur = ROWS - 1 if cur >= ROWS - 1 else cur + 1
    i += 1

dist = Counter(heights)
max_h = max(heights) if heights else -1
print(f"终端行数: {ROWS} · 帧样本: {len(heights)}")
print("ink 帧高分布: " + ", ".join(f"{k}行×{v}" for k, v in sorted(dist.items())))
print(f"最大帧高: {max_h}（必须 ≤ {ROWS-1}）· cursor-up 越顶: {clamps}")

ok = 0 < max_h <= ROWS - 1 and clamps == 0
print("✓ 钉底验证通过（重绘零滚屏，输入框钉在窗口底）" if ok else "✗ 验证未通过")
sys.exit(0 if ok else 1)
