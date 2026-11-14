"""Launch the bundled Node.js stdio proxy without Python dependencies."""

import os
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> None:
    node = shutil.which("node")
    if not node:
        print("mcp-nlm requires Node.js 22 or newer on PATH.", file=sys.stderr)
        raise SystemExit(1)
    entry = Path(__file__).parent / "runtime" / "cli.js"
    command = [node, str(entry), *sys.argv[1:]]
    if os.name != "nt":
        os.execv(node, command)
    child = subprocess.Popen(command)
    try:
        raise SystemExit(child.wait())
    except KeyboardInterrupt:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait()
        raise SystemExit(130)
