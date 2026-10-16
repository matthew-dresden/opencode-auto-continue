"""Check if a commit message is a release commit that should skip the pipeline.

Adapted from the prose-style release pipeline (identical logic; import
package renamed to ci).

Release commits start with 'chore(release):' and are created by the
release PR job. The pipeline should not release again for these commits;
the tag-release workflow uses them to create the tag and GitHub Release.

Usage:
    python3 -m ci.check_release_commit \
        --commit-message "chore(release): v0.2.0 (#4)" \
        --output "$GITHUB_OUTPUT"

Outputs written to $GITHUB_OUTPUT:
    should_skip: true when the commit is a release commit
    release_version: the version captured from the message, empty otherwise

Exit code 0 on success, 1 on error.
"""

import argparse
import pathlib

from ci.constants import RELEASE_COMMIT_VERSION_PATTERN


def parse_release_commit(message: str) -> dict:
    """Check a commit message and extract the release version when present.

    Args:
        message: The commit message to check.

    Returns:
        A dict with keys: should_skip (bool), release_version (str, possibly empty).
    """
    first_line = message.strip().split("\n")[0].strip()
    match = RELEASE_COMMIT_VERSION_PATTERN.match(first_line)
    if match:
        return {"should_skip": True, "release_version": match.group(1)}
    return {"should_skip": False, "release_version": ""}


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Check if commit is a release commit")
    parser.add_argument(
        "--commit-message", required=True, help="The commit message to check"
    )
    parser.add_argument(
        "--output", required=True, help="Path to GitHub Actions output file"
    )
    args = parser.parse_args()

    result = parse_release_commit(args.commit_message)

    if result["should_skip"]:
        print(
            f"Release commit detected for v{result['release_version']}, skipping pipeline"
        )

    with pathlib.Path(args.output).open("a") as f:
        f.write(f"should_skip={'true' if result['should_skip'] else 'false'}\n")
        f.write(f"release_version={result['release_version']}\n")


if __name__ == "__main__":
    main()
