// DLarr — local filesystem scanner
//
// Walks a local directory tree and returns nodes in the same shape as the
// remote scanner (design §7), so the reconciler can compare them without
// caring where the data came from.
//
// Also provides a mountpoint sanity check used by the delete-on-disappear
// feature to prevent mass deletion when the watch destination is unmounted.

import {
  readdirSync, statSync, accessSync, constants, existsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Scan a local directory tree, returning nodes in the dlarr_scan.py format.
 *
 * @param {string} rootPath absolute local path
 * @returns {Array<{ name, is_dir, mtime, size, children }>}
 *
 * If rootPath doesn't exist, returns [] rather than throwing. Callers that
 * need to distinguish "missing mountpoint" from "empty directory" should
 * call `isDestinationReadable` first.
 */
export function scanLocal(rootPath) {
  if (!existsSync(rootPath)) return [];
  try {
    const st = statSync(rootPath);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  return scanDir(rootPath);
}

function scanDir(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    // Permission denied or transient error — treat as empty
    return [];
  }

  const children = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const node = scanEntry(entry, fullPath);
    if (node !== null) children.push(node);
  }
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return children;
}

function scanEntry(entry, fullPath) {
  let stat;
  try {
    stat = statSync(fullPath);
  } catch {
    // File deleted mid-scan, or unreadable — skip
    return null;
  }

  const isDir = entry.isDirectory();
  const node = {
    name:   entry.name,
    is_dir: isDir,
    mtime:  Math.floor(stat.mtimeMs / 1000),
  };

  if (isDir) {
    const children = scanDir(fullPath);
    node.children = children;
    node.size = children.reduce((sum, c) => sum + c.size, 0);
  } else {
    node.children = [];
    node.size = stat.size;
  }

  return node;
}

/**
 * Check that the destination directory for a watch is present and readable.
 * Used by the delete-on-disappear guardrail (design §8.6 guardrail #2).
 *
 * Returns true if the directory exists, is a directory, and we have read
 * access. Returns false on any failure — missing, not-a-dir, permission-denied,
 * mountpoint gone, etc.
 *
 * @param {string} dirPath
 * @returns {boolean}
 */
export function isDestinationReadable(dirPath) {
  if (!dirPath) return false;
  try {
    const resolved = resolve(dirPath);
    if (!existsSync(resolved)) return false;
    const st = statSync(resolved);
    if (!st.isDirectory()) return false;
    accessSync(resolved, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
