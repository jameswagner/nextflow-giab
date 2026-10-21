#!/usr/bin/env python3
"""Pin every container image the repository uses by digest, or check that the pins are current.

Images are written as name@sha256:digest, with the tag they came from in a comment on the same line:

    container = 'quay.io/biocontainers/samtools@sha256:a130...'  // quay.io/biocontainers/samtools:1.24--h9dcdb79_1

The digest is what is pulled, so a registry cannot swap the contents behind a tag. (Nextflow rejects the
combined tag@digest form.) A new image can be added as a plain `name:tag` and this script pins it.
Looks in conf/containers.config, `container '...'` in .nf files, and ecs fromRegistry('...') in infra/lib.

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
CONTEXT = r"(?:(?<![-\w])container\s*=?\s*'|fromRegistry\(')"
PINNED = re.compile(rf"({CONTEXT})(?P<name>[^'@\s]+)@(?P<digest>sha256:[0-9a-f]{{64}})'(?P<mid>[^\n]*?)//\s*(?P<ref>\S+:\S+)\s*$", re.M)
PLAIN = re.compile(rf"({CONTEXT})(?P<ref>[^'@\s]+:[^'@\s]+)'")


def digest_of(ref):
    out = subprocess.run(["docker", "buildx", "imagetools", "inspect", ref], capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if line.startswith("Digest:"):
            return line.split()[1]
    raise SystemExit(f"could not read the digest of {ref}: {out.stderr.strip()[:200]}")


def main(argv):
    check = "--check" in argv
    cache, changes = {}, 0

    def digest(ref):
        cache.setdefault(ref, digest_of(ref))
        return cache[ref]

    for path in FILES:
        text = path.read_text()

        def refresh(m):
            nonlocal changes
            name, ref = m.group("name"), m.group("ref")
            if ref.rsplit(":", 1)[0] != name:
                raise SystemExit(f"{path.relative_to(ROOT)}: comment {ref!r} does not match image {name!r}")
            new = digest(ref)
            if new != m.group("digest"):
                changes += 1
                print(f"{path.relative_to(ROOT)}: {ref}  {m.group('digest')} -> {new}")
            return f"{m.group(1)}{name}@{new}'{m.group('mid')}// {ref}"

        def pin(m):
            nonlocal changes
            changes += 1
            ref = m.group("ref")
            print(f"{path.relative_to(ROOT)}: {ref}  unpinned -> {digest(ref)}")
            return f"{m.group(1)}{ref.rsplit(':', 1)[0]}@{digest(ref)}'"

        text = PINNED.sub(refresh, text)
        # An unpinned `name:tag` needs its comment too; add it after the closing quote's line.
        if PLAIN.search(text):
            lines = []
            for line in text.split("\n"):
                m = PLAIN.search(line)
                lines.append(PLAIN.sub(pin, line) + (f"  // {m.group('ref')}" if m else ""))
            text = "\n".join(lines)
        if not check:
            path.write_text(text)
    print(f"{len(cache)} images, {changes} reference(s) {'to update' if check else 'updated'}")
    return 1 if (check and changes) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
