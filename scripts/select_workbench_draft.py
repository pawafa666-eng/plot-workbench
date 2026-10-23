"""Select an uploaded draft by its exact tag; tag lookup only sees published releases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def select_draft(releases, tag):
    if not isinstance(releases, list):
        raise ValueError("Release listing must be an array")
    matches = [item for item in releases if isinstance(item, dict) and item.get("tag_name") == tag]
    if len(matches) != 1:
        raise ValueError("Expected exactly one release for the requested tag")
    release = matches[0]
    if release.get("draft") is not True:
        raise ValueError("Refusing to publish an already public release")
    if type(release.get("id")) is not int or release["id"] <= 0:
        raise ValueError("Draft release has no valid ID")
    return release


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--releases", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        release = select_draft(json.loads(args.releases.read_text("utf-8")), args.tag)
    except ValueError as error:
        parser.error(str(error))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(release["id"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
