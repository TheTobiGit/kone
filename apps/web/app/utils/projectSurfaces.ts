// The project page's spaces, in the order the centre nav shows them. One list:
// the nav, the intent menu's go-tos and the surface types all read it, so a new
// space is a line here rather than an edit in each of them.

export const PROJECT_SURFACES = ["overview", "space", "files", "git"] as const;

export type ProjectSurface = (typeof PROJECT_SURFACES)[number];

/** The name the centre nav gives each space. */
export const PROJECT_SURFACE_LABEL = {
  overview: "Overview",
  space: "Space",
  files: "Files",
  git: "Git",
} satisfies Record<ProjectSurface, string>;
