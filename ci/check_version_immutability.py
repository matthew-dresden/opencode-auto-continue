"""Check that version fields are not manually modified.

Adapted from the prose-style release pipeline: the version-bearing file is
package.json instead of pyproject.toml/SKILL.md.

The package.json "version" field is managed exclusively by the release
pipeline. Manual edits to it must be rejected in CI.

This script compares package.json in the working tree against a base ref
(e.g., origin/main) and fails if the version value was changed by the PR.

Usage (CI, PR validation):
    python3 -m ci.check_version_immutability --base-ref origin/main

Exit code 0 on success, 1 on error.
"""

import argparse
import re
import subprocess
import sys

from ci.constants import VERSION_FILE_PATHS

# JSON form: "version": "1.8.1"
VERSION_LINE_PATTERN = re.compile(r'"version"\s*:\s*"[^"]*"')


def get_removed_version_lines(base_ref: str) -> list[str]:
    """Get removed or modified version lines in the version files since base ref.

    Adding a version line is allowed (initial scaffolding). Changing or
    removing one is a manual edit and must be rejected: any diff line that
    starts with '-' and carries a version value signals an edit.

    Args:
        base_ref: Git ref to compare against (e.g. 'origin/main').

    Returns:
        List of removed or modified lines matching the version pattern.

    Raises:
        SystemExit: If the git command fails.
    """
    result = subprocess.run(
        ["git", "diff", f"{base_ref}..HEAD", "--", *VERSION_FILE_PATHS],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        print(
            f"::error::Failed to diff against {base_ref}: {result.stderr.strip()}",
            file=sys.stderr,
        )
        sys.exit(1)

    removed = []
    for line in result.stdout.splitlines():
        if line.startswith("-") and not line.startswith("---"):
            if VERSION_LINE_PATTERN.search(line[1:]):
                removed.append(line)
    return removed


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Reject manual edits to version fields managed by the release pipeline"
    )
    parser.add_argument(
        "--base-ref",
        required=True,
        help="Git ref to compare against (e.g. 'origin/main')",
    )
    args = parser.parse_args()

    changed = get_removed_version_lines(args.base_ref)

    if changed:
        print(
            "::error::Version fields are managed by the release pipeline and must not "
            "be edited manually. Revert changes to the version lines:",
            file=sys.stderr,
        )
        for line in changed:
            print(f"  {line}", file=sys.stderr)
        sys.exit(1)

    print(f"version immutability: no manual version edits against {args.base_ref}")


if __name__ == "__main__":
    main()
