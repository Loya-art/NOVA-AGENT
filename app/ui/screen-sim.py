#!/usr/bin/env python3
"""screen-sim.py — 把捕获的字节流按真实终端语义渲染成 60×120 的屏幕，逐帧打印可见画面。

用途：复现用户眼里的屏幕（发消息前后到底看到了什么）。
"""
import re
import sys

LOG = sys.argv[1] if len(sys.argv) > 1 else r"F:/AgentPortable/logs/tui-live.txt"
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 60
COLS = int(sys.argv[3]) if len(sys.argv) > 3 else 120
SHOW = int(sys.argv[4]) if len(sys.argv) > 4 else 8  # 打印最后 N 个画面

data = open(LOG, encoding="utf8", errors="replace").read()
CSI = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z])")


class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.buf = [[" "] * cols for _ in range(rows)]
        self.r = 0
        self.c = 0
        self.scrolls = 0

    def put(self, ch):
        if self.c >= self.cols:
            self.c = 0
            self.newline()
        self.buf[self.r][self.c] = ch
        self.c += 1

    def newline(self):
        if self.r >= self.rows - 1:
            self.buf.pop(0)
            self.buf.append([" "] * self.cols)
            self.scrolls += 1
        else:
            self.r += 1

    def feed(self, s):
        i, n = 0, len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                m = CSI.match(s, i)
                if m:
                    params, f = m.group(1), m.group(2)
                    nums = [int(x) for x in params.split(";") if x.isdigit()]
                    if f == "A":
                        self.r = max(0, self.r - (nums[0] if nums else 1))
                    elif f == "B":
                        self.r = min(self.rows - 1, self.r + (nums[0] if nums else 1))
                    elif f in "Hf":
                        r = (nums[0] if nums else 1) - 1
                        c = (nums[1] if len(nums) > 1 else 1) - 1
                        self.r = min(self.rows - 1, max(0, r))
                        self.c = min(self.cols - 1, max(0, c))
                    elif f == "G":
                        self.c = (nums[0] if nums else 1) - 1
                    elif f == "K":
                        mode = nums[0] if nums else 0
                        if mode == 0:
                            for x in range(self.c, self.cols):
                                self.buf[self.r][x] = " "
                        elif mode == 2:
                            self.buf[self.r] = [" "] * self.cols
                    elif f == "J":
                        for y in range(self.r, self.rows):
                            self.buf[y] = [" "] * self.cols
                    i = m.end()
                    continue
                if s[i:i + 2] == "\x1b]":  # OSC ... BEL/ST 跳过
                    j = s.find("\x07", i)
                    k = s.find("\x1b\\", i)
                    end = min(x for x in (j, k, len(s)) if x != -1) if (j != -1 or k != -1) else len(s)
                    i = end + 1
                    continue
                i += 1
                continue
            if ch == "\n":
                self.newline()
            elif ch == "\r":
                self.c = 0
            elif ch >= " ":
                self.put(ch)
            i += 1

    def dump(self):
        return "\n".join("".join(row).rstrip() for row in self.buf)


# 按 sync-begin 分块 = 一帧，逐帧渲染并记录屏幕快照
chunks = data.split("\x1b[?2026h")
scr = Screen(ROWS, COLS)
snaps = []
for idx, ch in enumerate(chunks):
    scr.feed(ch)
    snaps.append((idx, scr.scrolls, scr.dump()))

print(f"总块数: {len(chunks)} · 累计滚屏: {scr.scrolls} 行")
for idx, sc, dump in snaps[-SHOW:]:
    lines = dump.split("\n")
    nonblank = sum(1 for l in lines if l.strip())
    print(f"\n===== 块 #{idx}（累计滚屏 {sc}）· 可见非空行 {nonblank}/{ROWS} =====")
    for li, l in enumerate(lines):
        if l.strip():
            print(f"{li:>3}| {l[:110]}")
    print(f"    （{ROWS - nonblank} 行空白）")
