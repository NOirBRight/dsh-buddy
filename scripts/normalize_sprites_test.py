from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "normalize-sprites.py"


class NormalizeSpritesTests(unittest.TestCase):
    def test_missing_source_artwork_fails_without_using_generated_destination(self) -> None:
        environment = os.environ.copy()
        environment.pop("DSH_BUDDY_SPRITES_SOURCE", None)
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DSH_BUDDY_SPRITES_SOURCE", result.stderr)
        self.assertIn("refusing to read generated output", result.stderr)

    def test_missing_explicit_source_artwork_fails(self) -> None:
        environment = os.environ.copy()
        environment["DSH_BUDDY_SPRITES_SOURCE"] = str(ROOT / "missing-source-artwork.png")
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("sprite source does not exist", result.stderr)

    def test_source_cannot_resolve_to_generated_destination(self) -> None:
        environment = os.environ.copy()
        environment["DSH_BUDDY_SPRITES_SOURCE"] = str(ROOT / "page" / "buddy-sprites.png")
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not resolve to generated destination", result.stderr)

    def test_samefile_source_and_destination_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            (temporary_root / "scripts").mkdir()
            (temporary_root / "page").mkdir()
            temporary_script = temporary_root / "scripts" / "normalize-sprites.py"
            shutil.copy2(SCRIPT, temporary_script)
            source = temporary_root / "source.png"
            source.write_bytes(b"source")
            destination = temporary_root / "page" / "buddy-sprites.png"
            destination.hardlink_to(source)
            environment = os.environ.copy()
            environment["DSH_BUDDY_SPRITES_SOURCE"] = str(source)
            result = subprocess.run(
                [sys.executable, str(temporary_script)],
                cwd=temporary_root,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must not be the same file", result.stderr)

    def test_symlink_destination_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary_root = Path(directory)
            (temporary_root / "scripts").mkdir()
            (temporary_root / "page").mkdir()
            temporary_script = temporary_root / "scripts" / "normalize-sprites.py"
            shutil.copy2(SCRIPT, temporary_script)
            source = temporary_root / "source.png"
            source.write_bytes(b"source")
            target = temporary_root / "target.png"
            target.write_bytes(b"target")
            destination = temporary_root / "page" / "buddy-sprites.png"
            destination.symlink_to(target)
            environment = os.environ.copy()
            environment["DSH_BUDDY_SPRITES_SOURCE"] = str(source)
            result = subprocess.run(
                [sys.executable, str(temporary_script)],
                cwd=temporary_root,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("destination must not be a symlink", result.stderr)


if __name__ == "__main__":
    unittest.main()
