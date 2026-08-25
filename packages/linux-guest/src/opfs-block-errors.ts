// SPDX-License-Identifier: MIT

/** Translate browser storage failures into errno-shaped block I/O results. */
export function opfsBlockErrorCode(error: unknown): string {
  const name =
    error instanceof DOMException || error instanceof Error
      ? error.name
      : typeof error === "object" && error !== null && "name" in error
        ? String(error.name)
        : "Error";
  return name === "QuotaExceededError"
    ? "ENOSPC"
    : name === "NoModificationAllowedError" || name === "NotAllowedError"
      ? "EACCES"
      : name === "NotFoundError"
        ? "ENOENT"
        : name === "InvalidStateError"
          ? "EBADF"
          : "EIO";
}
