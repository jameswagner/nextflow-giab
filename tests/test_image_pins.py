"""Every container image the repository refers to must be pinned by digest: name@sha256:... with a
same-line comment naming the tag it came from (`// name:tag`).

A tag can be re-pointed at different contents; a digest cannot. This fails if a new image is added
without a digest, so CI catches it. Refresh digests with scripts/pin_images.py.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = r"(?:(?<![-\w])container\s*=?\s*'|fromRegistry\(')"
REFERENCE = re.compile(rf"{CONTEXT}([^']+)'([^\n]*)")
PINNED = re.compile(r"^(?P<name>[^@\s:]+(?::\d+)?[^@\s:]*)@sha256:[0-9a-f]{64}$")


def files():
    yield ROOT / "conf" / "containers.config"
    yield from sorted(ROOT.glob("**/*.nf"))
    yield from sorted((ROOT / "infra" / "lib").glob("*.ts"))


def references():
    for path in files():
        if "node_modules" in path.parts:
            continue
        for match in REFERENCE.finditer(path.read_text()):
            yield path.relative_to(ROOT), match.group(1), match.group(2)


class ImagePinTest(unittest.TestCase):
    def test_every_image_reference_is_pinned_by_digest_and_names_its_tag(self):
        found = list(references())
        self.assertGreaterEqual(len(found), 7, f"expected the pipeline's images, found {found}")
        for path, image, rest in found:
            pinned = PINNED.match(image)
            self.assertTrue(pinned, f"{path}: {image!r} is not name@sha256:digest")
            comment = re.search(r"//\s*(\S+):(\S+)\s*$", rest)
            self.assertTrue(comment, f"{path}: {image.split('@')[0]} has no `// name:tag` comment")
            self.assertEqual(comment.group(1), pinned.group("name"), f"{path}: comment names a different image")

    def test_the_same_image_has_the_same_digest_everywhere(self):
        digests = {}
        for path, image, _ in references():
            name, _, digest = image.partition("@")
            digests.setdefault(name, set()).add(digest)
        for name, seen in digests.items():
            self.assertEqual(len(seen), 1, f"{name} is pinned to different digests: {seen}")


if __name__ == "__main__":
    unittest.main()
