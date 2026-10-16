"""Shared constants for CI and release pipeline scripts.

Adapted from the prose-style release pipeline. The only difference: the
version-bearing file is package.json (JSON syntax) instead of
pyproject.toml/SKILL.md (TOML/frontmatter).

All configurable values used across multiple scripts are defined here.
Scripts that accept CLI arguments use these as defaults, allowing
runtime override via argparse.
"""

import re

# Release pipeline
RELEASE_COMMIT_PREFIX = "chore(release):"
CHANGELOG_HEADER = "# Changelog\n"
TAG_PREFIX = "v"
INITIAL_VERSION = (0, 0, 0)
VALID_BUMP_TYPES = frozenset({"major", "minor", "patch"})

# Version files managed exclusively by the release pipeline
VERSION_FILE_PATHS = ("package.json",)

# Conventional commit parsing
CONVENTIONAL_COMMIT_PATTERN = re.compile(
    r"^(feat|fix|chore|docs|style|refactor|test|perf|build|ci|revert|release|meta|module)"
    r"(\([a-zA-Z0-9_/-]+\))?(!)?:\s(.+)$"
)
MINOR_TYPES = frozenset(
    {"feat", "perf", "build", "ci", "revert", "release", "meta", "module"}
)
PATCH_TYPES = frozenset({"fix", "chore", "docs", "style", "refactor", "test"})

# Release commit parsing: captures the version from "chore(release): vX.Y.Z"
RELEASE_COMMIT_VERSION_PATTERN = re.compile(r"^chore\(release\):\s*v?(\d+\.\d+\.\d+)")

# Changelog section ordering
SECTION_ORDER = [
    "Breaking Changes",
    "Added",
    "Changed",
    "Fixed",
    "Documentation",
    "Maintenance",
    "Reverted",
]

# Commit type to changelog section mapping
COMMIT_TYPE_TO_SECTION = {
    "feat": "Added",
    "fix": "Fixed",
    "refactor": "Changed",
    "perf": "Changed",
    "docs": "Documentation",
    "chore": "Maintenance",
    "build": "Maintenance",
    "ci": "Maintenance",
    "revert": "Reverted",
    "style": "Maintenance",
    "test": "Maintenance",
    "release": "Maintenance",
    "meta": "Maintenance",
    "module": "Added",
}
