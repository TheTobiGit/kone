/**
 * The avatar fetch's IPC shapes — bytes for a picture the renderer cannot read
 * for itself.
 *
 * Its own `avatars:*` family rather than a corner of `roster:*` because this is
 * not a store operation: nothing is written, nothing is looked up. It is one
 * network read the renderer is not allowed to do, which is a different kind of
 * thing from every other channel the roster owns.
 */
export type AvatarFetchInput = {
  url: string;
};

/** The picture's bytes and what they are, or null if there was nothing to
 *  fetch — offline, refused, or an answer that wasn't an image. */
export type AvatarFetchResult = {
  mime: string;
  bytes: Uint8Array;
} | null;
