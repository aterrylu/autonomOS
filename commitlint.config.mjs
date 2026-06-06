// Conventional Commits enforcement (loose). Since changesets owns versioning,
// commit messages aren't release-critical — this is history hygiene. Rules are
// intentionally permissive so they catch typos without fighting real commits.

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // The project's commit types, including the repo-specific `init`/`research`.
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "perf",
        "refactor",
        "docs",
        "test",
        "build",
        "ci",
        "chore",
        "style",
        "revert",
        "init",
        "research",
      ],
    ],
    // Allow any subject case (we mix sentence + lower).
    "subject-case": [0],
    // Our headers are occasionally long + descriptive.
    "header-max-length": [2, "always", 120],
    // Bodies routinely carry URLs, file paths, and code — don't wrap-police them.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
