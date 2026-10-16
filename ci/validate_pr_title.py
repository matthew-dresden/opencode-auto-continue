"""Validate that a PR title or commit message follows conventional commit format.

Adapted from the prose-style release pipeline (identical logic; import
package renamed to ci).

Parses the message against the conventional commit regex pattern and returns
structured JSON with the parsed components and the inferred version bump level.

Usage:
    python3 -m ci.validate_pr_title --title "feat: add export command"
    python3 -m ci.validate_pr_title --title "fix!: critical parse bug"

Output (JSON to stdout):
    {"valid": true, "type": "feat", "scope": null, "breaking": false,
     "description": "add export command", "bump": "minor"}

Exit code 0 if valid, 1 if invalid.
"""

import argparse
import json
import sys

from ci.constants import CONVENTIONAL_COMMIT_PATTERN, MINOR_TYPES, PATCH_TYPES


def parse_commit_message(message: str) -> dict:
    """Parse a conventional commit message and return structured components.

    Args:
        message: The PR title or commit message.

    Returns:
        A dict with keys: valid, type, scope, breaking, description, bump.
        When valid is False, type/scope/description/bump are None and an
        error key describes the problem.
    """
    if not message or not message.strip():
        return {
            "valid": False,
            "type": None,
            "scope": None,
            "breaking": False,
            "description": None,
            "bump": None,
            "error": "Empty commit message",
        }

    first_line = message.strip().split("\n")[0].strip()
    match = CONVENTIONAL_COMMIT_PATTERN.match(first_line)
    if not match:
        return {
            "valid": False,
            "type": None,
            "scope": None,
            "breaking": False,
            "description": None,
            "bump": None,
            "error": f"Message does not match conventional commit format: {message}",
        }

    commit_type = match.group(1)
    raw_scope = match.group(2)
    bang = match.group(3)
    description = match.group(4)

    scope = raw_scope[1:-1] if raw_scope else None
    breaking = bang == "!"

    if breaking:
        bump = "major"
    elif commit_type in MINOR_TYPES:
        bump = "minor"
    elif commit_type in PATCH_TYPES:
        bump = "patch"
    else:
        bump = None

    return {
        "valid": True,
        "type": commit_type,
        "scope": scope,
        "breaking": breaking,
        "description": description,
        "bump": bump,
    }


def main() -> None:
    """CLI entry point for PR title validation."""
    parser = argparse.ArgumentParser(
        description="Validate a PR title or commit message against conventional commit format."
    )
    parser.add_argument(
        "--title",
        required=True,
        help="The PR title or commit message to validate.",
    )
    args = parser.parse_args()

    result = parse_commit_message(args.title)

    json.dump(result, sys.stdout)
    print()

    if not result["valid"]:
        print(result["error"], file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
