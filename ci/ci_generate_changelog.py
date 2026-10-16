"""CI wrapper for changelog generation with GITHUB_OUTPUT.

Adapted from the prose-style release pipeline (identical logic; import
package renamed to ci).

Generates the changelog entry for the release and writes the written
changelog path as a workflow output.

Usage:
    python3 -m ci.ci_generate_changelog \
        --version 0.2.0 \
        --tag-prefix v \
        --output "$GITHUB_OUTPUT"

Outputs written to $GITHUB_OUTPUT:
    changelog_path

Exit code 0 on success, 1 on error.
"""

import argparse
import pathlib
import sys

from ci.constants import TAG_PREFIX
from ci.generate_changelog import generate_changelog


def main() -> None:
    """CLI entry point for the CI changelog generation wrapper."""
    parser = argparse.ArgumentParser(
        description="Generate changelog entry and emit GitHub Actions outputs."
    )
    parser.add_argument(
        "--version",
        required=True,
        help="New version string (e.g. '0.2.0').",
    )
    parser.add_argument(
        "--tag-prefix",
        default=TAG_PREFIX,
        help="Tag prefix used to find commits since last tag (default: 'v').",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Path to the GitHub Actions output file.",
    )
    args = parser.parse_args()

    changelog_path = generate_changelog(
        version=args.version, tag_prefix=args.tag_prefix
    )

    with pathlib.Path(args.output).open("a") as f:
        f.write(f"changelog_path={changelog_path}\n")

    print(f"changelog updated: {changelog_path}")


if __name__ == "__main__":
    main()
