"""Update the version field in package.json.

Adapted from the prose-style release pipeline: the version-bearing file is
package.json instead of pyproject.toml/SKILL.md.

The release pipeline owns the package.json "version" field. Manual edits
are rejected by ci/check_version_immutability.py.

Usage:
    python3 -m ci.update_version_files --version 0.2.0

Output (JSON to stdout):
    {"files_updated": ["package.json"]}

Exit code 0 on success, 1 on error.
"""

import argparse
import json
import pathlib
import re
import sys

PACKAGE_JSON_VERSION_PATTERN = re.compile(
    r'^(\s*"version"\s*:\s*")[^"]*(")', re.MULTILINE
)


def update_package_json_version(version: str) -> str:
    """Update the version field in package.json.

    Args:
        version: New semver version string (e.g. "0.2.0").

    Returns:
        The file path that was updated.

    Raises:
        SystemExit: If package.json is not found or the version line cannot be located.
    """
    package_path = pathlib.Path("package.json")

    if not package_path.exists():
        sys.stderr.write(f"ERROR: package.json not found at {package_path.resolve()}\n")
        sys.exit(1)

    content = package_path.read_text()
    new_content, count = PACKAGE_JSON_VERSION_PATTERN.subn(
        f"\\g<1>{version}\\g<2>", content, count=1
    )

    if count == 0:
        sys.stderr.write("ERROR: Could not find version field in package.json\n")
        sys.exit(1)

    package_path.write_text(new_content)

    return str(package_path)


def update_version_files(version: str) -> list[str]:
    """Update every version file owned by the release pipeline.

    Args:
        version: New semver version string (e.g. "0.2.0").

    Returns:
        List of file paths (relative to repo root) that were updated.
    """
    return [
        update_package_json_version(version),
    ]


def main() -> None:
    """CLI entry point for updating version files.

    Outputs a JSON object with the list of files updated to stdout.
    Exits with code 0 on success, code 1 on error.
    """
    parser = argparse.ArgumentParser(
        description="Update the version field in package.json"
    )
    parser.add_argument(
        "--version",
        required=True,
        help="New semver version string (e.g. '0.2.0')",
    )
    args = parser.parse_args()

    files_updated = update_version_files(version=args.version)

    output = json.dumps({"files_updated": files_updated})
    sys.stdout.write(output + "\n")


if __name__ == "__main__":
    main()
