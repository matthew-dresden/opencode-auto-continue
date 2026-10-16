"""Generate or update the repository CHANGELOG.md for a release.

Adapted from the prose-style release pipeline (identical logic; import
package renamed to ci).

Parses git history since the last matching tag, groups commits by
conventional commit type into Keep-a-Changelog sections, and writes the
formatted entry to the root CHANGELOG.md file.

Usage:
    python3 -m ci.generate_changelog --version 0.2.0 --tag-prefix v

Output (JSON to stdout):
    {"changelog_path": "CHANGELOG.md"}

Exit code 0 on success, 1 on error.
"""

import argparse
import datetime
import json
import pathlib
import subprocess
import sys

from ci.constants import (
    CHANGELOG_HEADER,
    COMMIT_TYPE_TO_SECTION,
    SECTION_ORDER,
    TAG_PREFIX,
)
from ci.validate_pr_title import parse_commit_message


def _find_last_tag(tag_prefix: str) -> str | None:
    """Find the most recent tag matching the given prefix.

    Args:
        tag_prefix: The prefix to filter tags (e.g. "v").

    Returns:
        The tag string if found, or None if no matching tags exist.

    Raises:
        SystemExit: If the git command fails.
    """
    result = subprocess.run(
        ["git", "tag", "-l", f"{tag_prefix}*", "--sort=-v:refname"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(
            f"ERROR: git tag command failed: {result.stderr.strip()}",
            file=sys.stderr,
        )
        sys.exit(1)
    tags = result.stdout.strip().splitlines()
    if tags and tags[0]:
        return tags[0]
    return None


def _get_commits(last_tag: str | None) -> list[str]:
    """Get commit messages since the last tag.

    Args:
        last_tag: The tag to start from, or None for all commits.

    Returns:
        A list of commit message subject lines.

    Raises:
        SystemExit: If the git command fails.
    """
    if last_tag is not None:
        cmd = ["git", "log", f"{last_tag}..HEAD", "--format=%s"]
    else:
        cmd = ["git", "log", "--format=%s"]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(
            f"ERROR: git log command failed: {result.stderr.strip()}",
            file=sys.stderr,
        )
        sys.exit(1)
    lines = result.stdout.strip().splitlines()
    return [line for line in lines if line.strip()]


def _group_commits(commit_messages: list[str]) -> dict[str, list[str]]:
    """Parse and group commit messages into changelog sections.

    Args:
        commit_messages: Raw commit subject lines.

    Returns:
        A dict mapping section names to lists of description strings.
    """
    sections: dict[str, list[str]] = {}
    for msg in commit_messages:
        parsed = parse_commit_message(msg)
        if not parsed["valid"]:
            continue
        commit_type = parsed["type"]
        description = parsed["description"]
        is_breaking = parsed["breaking"]

        if is_breaking:
            sections.setdefault("Breaking Changes", []).append(description)

        section_name = COMMIT_TYPE_TO_SECTION.get(commit_type)
        if section_name is not None:
            sections.setdefault(section_name, []).append(description)

    return sections


def _format_entry(version: str, date_str: str, sections: dict[str, list[str]]) -> str:
    """Format grouped commits into a Keep-a-Changelog entry.

    Args:
        version: The release version string.
        date_str: The release date in YYYY-MM-DD format.
        sections: A dict mapping section names to lists of descriptions.

    Returns:
        A formatted changelog entry string.
    """
    lines = [f"## [{version}] - {date_str}"]

    for section_name in SECTION_ORDER:
        if section_name not in sections:
            continue
        lines.append("")
        lines.append(f"### {section_name}")
        lines.append("")
        for desc in sections[section_name]:
            lines.append(f"- {desc}")

    lines.append("")
    return "\n".join(lines)


def _write_changelog(changelog_path: pathlib.Path, entry: str) -> None:
    """Write or update the CHANGELOG.md file with the new entry.

    If the file exists, inserts the entry after the first title line
    (a line starting with '# '). If no title line is found, prepends
    the entry. If the file does not exist, creates it with a header.

    Args:
        changelog_path: The path to the CHANGELOG.md file.
        entry: The formatted changelog entry to insert.
    """
    if changelog_path.exists():
        existing = changelog_path.read_text()
        lines = existing.splitlines(keepends=True)
        title_index = None
        for i, line in enumerate(lines):
            if line.startswith("# "):
                title_index = i
                break

        if title_index is not None:
            insert_pos = title_index + 1
            separator = "\n"
            before = lines[:insert_pos]
            after = lines[insert_pos:]
            new_content = "".join(before) + separator + entry + "".join(after)
        else:
            new_content = entry + existing
        changelog_path.write_text(new_content)
    else:
        changelog_path.parent.mkdir(parents=True, exist_ok=True)
        changelog_path.write_text(CHANGELOG_HEADER + "\n" + entry)


def generate_changelog(
    *,
    version: str,
    tag_prefix: str,
    date_str: str | None = None,
) -> str:
    """Generate or update the root CHANGELOG.md for the release.

    Args:
        version: The new version string (e.g. "0.2.0").
        tag_prefix: Tag prefix used to find commits since last tag (e.g. "v").
        date_str: Optional date string in YYYY-MM-DD format. Defaults to today.

    Returns:
        The relative path to the written CHANGELOG.md file.

    Raises:
        SystemExit: On git command failures.
    """
    if date_str is None:
        date_str = datetime.date.today().isoformat()

    last_tag = _find_last_tag(tag_prefix)
    commits = _get_commits(last_tag)
    sections = _group_commits(commits)
    entry = _format_entry(version, date_str, sections)
    _write_changelog(pathlib.Path("CHANGELOG.md"), entry)

    return "CHANGELOG.md"


def main() -> None:
    """CLI entry point for changelog generation."""
    parser = argparse.ArgumentParser(
        description="Generate or update the root CHANGELOG.md for a release."
    )
    parser.add_argument(
        "--version",
        required=True,
        help="The new version string (e.g. '0.2.0').",
    )
    parser.add_argument(
        "--tag-prefix",
        default=TAG_PREFIX,
        help="Tag prefix used to find commits since last tag (default: 'v').",
    )
    parser.add_argument(
        "--date",
        default=None,
        help="Date string for the entry in YYYY-MM-DD format (default: today).",
    )
    args = parser.parse_args()

    changelog_path = generate_changelog(
        version=args.version,
        tag_prefix=args.tag_prefix,
        date_str=args.date,
    )

    json.dump({"changelog_path": changelog_path}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
