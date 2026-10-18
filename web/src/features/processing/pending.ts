/** The file dropped on Landing, handed to the processing page across the route change (not persisted). */
let pending: File | null = null;
/** Files the user agreed to cut to the length limit (uploaded with `trim=1`). */
const trimmed = new WeakSet<File>();

export const setPendingFile = (f: File | null, trim = false) => {
  pending = f;
  if (f && trim) trimmed.add(f);
};

export const takePendingFile = (): File | null => {
  const f = pending;
  pending = null;
  return f;
};

/** True while a dropped file waits for the processing page. */
export const hasPendingFile = () => pending !== null;

/** The user chose to keep only the first `MAX_UPLOAD_SECONDS` of this file. */
export const isTrimmed = (f: File) => trimmed.has(f);
