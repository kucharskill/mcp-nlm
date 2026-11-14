"""Check exact distribution contents and matching package versions."""

import hashlib
import json
from pathlib import Path
import sys
import tarfile
import tomllib
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "package.json").read_text())['version']
assert tomllib.loads((root / "pyproject.toml").read_text())['project']['version'] == version
directory = Path(sys.argv[1])
wheel = directory / f"mcp_nlm-{version}-py3-none-any.whl"
source = directory / f"mcp_nlm-{version}.tar.gz"
runtime = {"cli.js", "proxy.js", "package.json"}
with zipfile.ZipFile(wheel) as archive:
    names = set(archive.namelist())
    prefix = f"mcp_nlm-{version}.dist-info/"
    expected = {"mcp_nlm/__init__.py"} | {f"mcp_nlm/runtime/{name}" for name in runtime}
    expected |= {prefix + name for name in ["METADATA", "WHEEL", "entry_points.txt", "RECORD", "licenses/LICENSE"]}
    assert names == expected, f"Unexpected wheel content: {names ^ expected}"
    for name in runtime:
        assert archive.read(f"mcp_nlm/runtime/{name}") == (root / name).read_bytes()
with tarfile.open(source) as archive:
    prefix = f"mcp_nlm-{version}/"
    names = {member.name.removeprefix(prefix) for member in archive.getmembers() if member.isfile()}
    expected = runtime | {"src/mcp_nlm/__init__.py", "README.md", "LICENSE", "pyproject.toml", "PKG-INFO", ".gitignore"}
    assert names == expected, f"Unexpected sdist content: {names ^ expected}"
for path in (wheel, source):
    print(json.dumps({"archive": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}))
print("Archive allowlists and versions verified.")
