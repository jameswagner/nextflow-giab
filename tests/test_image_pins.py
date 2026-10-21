"""Every container image the repository refers to must be pinned by digest (tag@sha256:...).

A tag can be re-pointed at different contents; a digest cannot. This fails if a new image is added
without a digest, so CI catches it. Refresh digests with scripts/pin_images.py.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REFERENCES = [re.compile(r"(?<![-\w])container\s*=?\s*'([^']+)'"), re.compile(r"fromRegistry\('([^']+)'")]
PINNED = re.compile(r"^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$")


def files():
    yield ROOT / "conf" / "containers.config"
    yield from sorted(ROOT.glob("**/*.nf"))
    yield from sorted((ROOT / "infra" / "lib").glob("*.ts"))


class ImagePinTest(unittest.TestCase):
    def test_every_image_reference_is_pinned_by_digest_with_a_tag(self):
        found = []
        for path in files():
            if "node_modules" in path.parts:
                continue
            for pattern in REFERENCES:
                for image in pattern.findall(path.read_text()):
                    found.append((path.relative_to(ROOT), image))
                    self.assertRegex(image, PINNED, f"{path.relative_to(ROOT)}: {image!r} is not tag@sha256:digest")
        self.assertGreaterEqual(len(found), 7, f"expected the pipeline's images, found {found}")

    def test_the_same_image_has_the_same_digest_everywhere(self):
        digests = {}
        for path in files():
            if "node_modules" in path.parts:
                continue
            for pattern in REFERENCES:
                for image in pattern.findall(path.read_text()):
                    name, _, digest = image.partition("@")
                    digests.setdefault(name, set()).add(digest)
        for name, seen in digests.items():
            self.assertEqual(len(seen), 1, f"{name} is pinned to different digests: {seen}")


if __name__ == "__main__":
    unittest.main()
