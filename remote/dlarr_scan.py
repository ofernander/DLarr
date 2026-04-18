#!/usr/bin/env python3
# DLarr remote scanner
#
# Walks a directory tree and emits JSON to stdout. Used by DLarr to get
# a full listing of files on a remote seedbox.
#
# Contract (see design §7):
#   - Input: single path argument
#   - Output: JSON array of nodes, written to stdout
#   - Each node: { name, size, is_dir, mtime, children }
#   - Directory sizes are pre-summed from their children
#   - mtime is a unix timestamp (integer seconds)
#   - Stdlib only, no third-party deps
#   - Python 3.6+ (use os.scandir, f-strings)
#
# Errors go to stderr. Exit code 0 on success, 1 on failure.
#
# This script is scp'd to the remote server. DLarr verifies the local md5
# against the remote md5 before each boot and re-installs if changed.

import json
import os
import sys


def scan_entry(entry):
    """Convert an os.DirEntry into a node dict."""
    try:
        stat = entry.stat(follow_symlinks=False)
    except OSError as err:
        # File/dir may have been deleted between listing and stat. Skip.
        print(f"dlarr_scan: stat failed for {entry.path}: {err}", file=sys.stderr)
        return None

    is_dir = entry.is_dir(follow_symlinks=False)
    node = {
        "name": entry.name,
        "is_dir": is_dir,
        "mtime": int(stat.st_mtime),
    }

    if is_dir:
        children = scan_dir(entry.path)
        node["children"] = children
        node["size"] = sum(c["size"] for c in children)
    else:
        node["children"] = []
        node["size"] = stat.st_size

    return node


def scan_dir(path):
    """Scan a directory, returning a list of child nodes sorted by name."""
    children = []
    try:
        with os.scandir(path) as it:
            for entry in it:
                node = scan_entry(entry)
                if node is not None:
                    children.append(node)
    except OSError as err:
        print(f"dlarr_scan: scandir failed for {path}: {err}", file=sys.stderr)
        return []

    children.sort(key=lambda n: n["name"])
    return children


def main():
    if len(sys.argv) != 2:
        print("usage: dlarr_scan.py <path>", file=sys.stderr)
        sys.exit(1)

    root = sys.argv[1]

    if not os.path.exists(root):
        print(f"dlarr_scan: path does not exist: {root}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isdir(root):
        print(f"dlarr_scan: path is not a directory: {root}", file=sys.stderr)
        sys.exit(1)

    result = scan_dir(root)
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
