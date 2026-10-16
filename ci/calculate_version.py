"""Calculate the next semantic version from git tags and commit messages.

Adapted from the prose-style release pipeline (identical logic; import
package renamed to ci).

Finds the latest git tag matching the "v" prefix, parses a conventional
commit message, and calculates the next semantic version.

Usage:
    python3 -m ci.calculate_version --commit-message "feat: add export"

Output (JSON to stdout):
    {"tag_prefix": "v", "current_version": "0.1.0",
     "next_version": "0.2.0", "bump_type": "minor",
     "full_tag": "v0.2.0", "is_initial": false}

Exit code 0 on success, 1 on error.
"""

import argparse
import json
import subprocess
import sys

from ci.constants import INITIAL_VERSION, TAG_PREFIX, VALID_BUMP_TYPES
from ci.generate_changelog import _find_last_tag, _get_commits
from ci.validate_pr_title import parse_commit_message

BUMP_RANK = {"patch": 1, "minor": 2, "major": 3}


def _max_bump_since_last_tag(tag_prefix: str) -> str:
    """Determine the highest bump level across commits since the last tag.

    Squash merges deliver one conventional commit per PR, so scanning the
    full range releases every pending change at its correct level.

    Args:
        tag_prefix: The tag prefix to search (e.g. "v").

    Returns:
        One of "major", "minor", "patch".

    Raises:
        SystemExit: If a commit message is not a valid conventional commit.
    """
    last_tag = _find_last_tag(tag_prefix)
    commits = _get_commits(last_tag)
    highest = "patch"
    for subject in commits:
        parsed = parse_commit_message(subject)
        if not parsed["valid"]:
            print(f"Error: invalid commit message: {parsed['error']}", file=sys.stderr)
            sys.exit(1)
        if not parsed["bump"]:
            continue
        if BUMP_RANK[parsed["bump"]] > BUMP_RANK[highest]:
            highest = parsed["bump"]
    return highest


def _parse_semver(version_string: str) -> tuple[int, int, int] | None:
    """Parse a MAJOR.MINOR.PATCH version string into a tuple.

    Args:
        version_string: A string like "1.2.3".

    Returns:
        A tuple (major, minor, patch) or None if parsing fails.
    """
    parts = version_string.split(".")
    if len(parts) != 3:
        return None
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def _format_version(version: tuple[int, int, int]) -> str:
    """Format a version tuple as MAJOR.MINOR.PATCH string."""
    return f"{version[0]}.{version[1]}.{version[2]}"


def _apply_bump(version: tuple[int, int, int], bump_type: str) -> tuple[int, int, int]:
    """Apply a version bump to a semver tuple.

    Args:
        version: Current version as (major, minor, patch).
        bump_type: One of "major", "minor", "patch".

    Returns:
        The bumped version tuple.
    """
    major, minor, patch = version
    if bump_type == "major":
        return (major + 1, 0, 0)
    if bump_type == "minor":
        return (major, minor + 1, 0)
    return (major, minor, patch + 1)


def _git_tags_for_prefix(tag_prefix: str) -> list[str]:
    """Run git tag -l to find all tags matching a prefix.

    Args:
        tag_prefix: The prefix to search (e.g. "v").

    Returns:
        List of matching tag strings.

    Raises:
        SystemExit: If the git command fails.
    """
    result = subprocess.run(
        ["git", "tag", "-l", f"{tag_prefix}*"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(f"Error: git tag -l failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    tags = [line.strip() for line in result.stdout.strip().split("\n") if line.strip()]
    return tags


def _git_tag_exists(full_tag: str) -> bool:
    """Check whether a specific git tag already exists.

    Args:
        full_tag: The full tag string to check (e.g. "v0.2.0").

    Returns:
        True if the tag exists, False otherwise.

    Raises:
        SystemExit: If the git command fails.
    """
    result = subprocess.run(
        ["git", "tag", "-l", full_tag],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(f"Error: git tag -l failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return full_tag in result.stdout.strip().split("\n")


def _find_latest_version(
    tags: list[str], tag_prefix: str
) -> tuple[tuple[int, int, int], bool]:
    """Find the latest semver version from a list of tags.

    Args:
        tags: List of full tag strings (e.g. ["v0.1.0", ...]).
        tag_prefix: The prefix to strip to extract the version suffix.

    Returns:
        A tuple of (version_tuple, is_initial) where is_initial is True
        when no valid tags were found and 0.0.0 is used as the base.
    """
    versions: list[tuple[int, int, int]] = []

    for tag in tags:
        if not tag.startswith(tag_prefix):
            continue
        suffix = tag[len(tag_prefix) :]
        parsed = _parse_semver(suffix)
        if parsed is not None:
            versions.append(parsed)

    if not versions:
        return INITIAL_VERSION, True

    versions.sort()
    return versions[-1], False


def calculate_version(
    tag_prefix: str,
    bump_type: str,
) -> dict:
    """Calculate the next semantic version for the repository.

    Finds existing git tags, determines the current version, and applies
    the specified bump type to compute the next version.

    Args:
        tag_prefix: The tag prefix (e.g. "v").
        bump_type: One of "major", "minor", "patch".

    Returns:
        A dict with keys: tag_prefix, current_version, next_version,
        bump_type, full_tag, is_initial.

    Raises:
        SystemExit: If the computed tag already exists or git commands fail.
    """
    if bump_type not in VALID_BUMP_TYPES:
        print(
            f"Error: invalid bump type '{bump_type}'. Must be one of: {sorted(VALID_BUMP_TYPES)}",
            file=sys.stderr,
        )
        sys.exit(1)

    existing_tags = _git_tags_for_prefix(tag_prefix)
    current_version, is_initial = _find_latest_version(existing_tags, tag_prefix)
    next_version = _apply_bump(current_version, bump_type)

    full_tag = f"{tag_prefix}{_format_version(next_version)}"

    if _git_tag_exists(full_tag):
        print(f"Error: tag '{full_tag}' already exists", file=sys.stderr)
        sys.exit(1)

    return {
        "tag_prefix": tag_prefix,
        "current_version": _format_version(current_version),
        "next_version": _format_version(next_version),
        "bump_type": bump_type,
        "full_tag": full_tag,
        "is_initial": is_initial,
    }


def main() -> None:
    """CLI entry point for version calculation."""
    parser = argparse.ArgumentParser(
        description="Calculate the next semantic version from git tags and commit messages."
    )
    parser.add_argument(
        "--commit-message",
        default=None,
        help="A commit message to parse directly (overrides scanning since the last tag).",
    )
    parser.add_argument(
        "--scan-since-tag",
        action="store_true",
        default=True,
        help="Scan all commits since the last tag and take the highest bump (default).",
    )
    parser.add_argument(
        "--tag-prefix",
        default=TAG_PREFIX,
        help="Tag prefix for releases (default: v).",
    )
    parser.add_argument(
        "--bump-type",
        default=None,
        choices=sorted(VALID_BUMP_TYPES),
        help="Version bump type: major, minor, or patch. Overrides commit message parsing.",
    )
    args = parser.parse_args()

    if args.bump_type:
        bump_type = args.bump_type
    elif args.commit_message:
        parsed = parse_commit_message(args.commit_message)
        if not parsed["valid"]:
            print(f"Error: invalid commit message: {parsed['error']}", file=sys.stderr)
            sys.exit(1)
        if not parsed["bump"]:
            print(
                f"Error: commit type '{parsed['type']}' does not map to a version bump",
                file=sys.stderr,
            )
            sys.exit(1)
        bump_type = parsed["bump"]
    else:
        bump_type = _max_bump_since_last_tag(args.tag_prefix)

    result = calculate_version(args.tag_prefix, bump_type)

    json.dump(result, sys.stdout)
    print()


if __name__ == "__main__":
    main()
