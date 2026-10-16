"""CI wrapper for version calculation with GITHUB_OUTPUT.

Adapted from the prose-style release pipeline (identical logic; import
package renamed to ci).

Scans all commits since the last tag, takes the highest bump level, and
calculates the next version from git tags.

Usage:
    python3 -m ci.ci_calculate_version --output "$GITHUB_OUTPUT"

Outputs written to $GITHUB_OUTPUT:
    next_version, bump_type, full_tag, is_initial

Exit code 0 on success, 1 on error.
"""

import argparse
import pathlib
import sys

from ci.calculate_version import calculate_version, _max_bump_since_last_tag
from ci.constants import TAG_PREFIX


def main() -> None:
    """CLI entry point for the CI version calculation wrapper."""
    parser = argparse.ArgumentParser(
        description="Calculate next version and emit GitHub Actions outputs."
    )
    parser.add_argument(
        "--tag-prefix",
        default=TAG_PREFIX,
        help="Tag prefix for releases (default: v).",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Path to the GitHub Actions output file.",
    )
    args = parser.parse_args()

    bump_type = _max_bump_since_last_tag(args.tag_prefix)
    result = calculate_version(args.tag_prefix, bump_type)

    with pathlib.Path(args.output).open("a") as f:
        f.write(f"next_version={result['next_version']}\n")
        f.write(f"bump_type={result['bump_type']}\n")
        f.write(f"full_tag={result['full_tag']}\n")
        f.write(f"is_initial={'true' if result['is_initial'] else 'false'}\n")

    print(
        f"version: {result['current_version']} -> {result['next_version']} "
        f"({result['bump_type']}, tag {result['full_tag']})"
    )


if __name__ == "__main__":
    main()
