#!/usr/bin/env python3
"""Extract the release notes section for a given tag from CHANGELOG.md.

Usage: python3 scripts/extract-release-notes.py <tag>
Writes RELEASE_NOTES.md in the repo root. Falls back to a generic line when
the tag has no section.
"""
import re
import sys

tag = sys.argv[1] if len(sys.argv) > 1 else ""
text = open("CHANGELOG.md", encoding="utf-8").read()
match = re.search(rf"^## \[{re.escape(tag)}\].*?\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
notes = match.group(1).strip() if match else ""
if not notes:
    notes = "See the commit history for changes in this release."
with open("RELEASE_NOTES.md", "w", encoding="utf-8") as f:
    f.write(notes + "\n")
print(f"release notes for {tag}: {len(notes)} chars")
