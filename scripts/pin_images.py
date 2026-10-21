#!/usr/bin/env python3
"""Pin every container image the repository uses by digest, or check that the pins are current.

Images are written as tag@sha256:digest: the tag says what the image is, and the digest is what is
pulled, so a registry cannot swap the contents behind a tag. Finds image references in
conf/containers.config, any `container '...'` in .nf files, and ecs fromRegistry('...') in infra/lib.

Usage: scripts/pin_images.py            rewrite every reference to the digest its tag points at today
       scripts/pin_images.py --check    only report references whose digest no longer matches the tag
Needs docker (buildx) to read digests from the registries. Run it deliberately when upgrading an image,
and review the diff: a changed digest under the same tag means the registry's contents changed.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [ROOT / "conf" / "containers.config", *sorted(ROOT.glob("**/*.nf")), *sorted((ROOT / "infra" / "lib").glob("*.ts"))]
FILES = [f for f in FILES if "node_modules" not in f.parts]
# 'image:tag' or 'image:tag@sha256:...' inside the quotes of the three forms we use.
PATTERNS = [re.compile(r"((?<![-\w])container\s*=?\s*')([^'@\s]+:[^'@\s]+)(?:@(sha256:[0-9a-f]{64}))?(')"),
            re.compile(r"(fromRegistry\(')([^'@\s]+:[^'@\s]+)(?:@(sha256:[0-9a-f]{64}))?(')")]


def digest_of(image):
    out = subprocess.run(["docker", "buildx", "imagetools", "inspect", image], capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if line.startswith("Digest:"):
            return line.split()[1]
    raise SystemExit(f"could not read the digest of {image}: {out.stderr.strip()[:200]}")


def main(argv):
    check = "--check" in argv
    cache, stale = {}, 0
    for path in FILES:
        text = path.read_text()
        for pattern in PATTERNS:
            def replace(match):
                nonlocal stale
                head, image, old, tail = match.groups()
                cache.setdefault(image, digest_of(image))
                new = cache[image]
                if old != new:
                    stale += 1
                    print(f"{path.relative_to(ROOT)}: {image}  {old or 'unpinned'} -> {new}")
                return f"{head}{image}@{new}{tail}"
            text = pattern.sub(replace, text)
        if not check:
            path.write_text(text)
    print(f"{len(cache)} images, {stale} reference(s) {'out of date' if check else 'updated'}")
    return 1 if (check and stale) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
