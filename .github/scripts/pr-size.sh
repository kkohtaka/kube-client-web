#!/usr/bin/env bash
# Counts the lines a pull request changes and fails above a limit.
#
#   pr-size.sh <base> <head>
#
# Counts added plus deleted lines between the merge base of the two commits
# and <head>. Files that nobody reads line by line are left out. Tests count:
# a changed test deserves at least as careful a look as the code.
#
# PR_SIZE_LIMIT     the limit, 600 unless set
# PR_SIZE_ALLOWED   "true" lets a larger change pass; the workflow sets it
#                   when the pull request has the large-change label
set -euo pipefail

base=$1
head=$2
limit=${PR_SIZE_LIMIT:-600}

not_counted=(
  pnpm-lock.yaml
  CHANGELOG.md
  '.changeset/*.md'
  .devcontainer/devcontainer-lock.json
)

pathspec=(.)
for path in "${not_counted[@]}"; do
  pathspec+=(":(exclude)$path")
done

# A binary file has "-" for both counts, which awk reads as 0.
changes=$(git diff --numstat "$base...$head" -- "${pathspec[@]}")
total=$(awk '{ sum += $1 + $2 } END { print sum + 0 }' <<<"$changes")

echo "Changed lines, largest first:"
sort -k1,1nr -k2,2nr <<<"$changes" | awk 'NF { printf "  %6d  %s\n", $1 + $2, $3 }'
echo "Total: $total (limit: $limit)"

if [ "$total" -le "$limit" ]; then
  exit 0
fi

if [ "${PR_SIZE_ALLOWED:-}" = "true" ]; then
  echo "Over the limit, and allowed by the large-change label."
  exit 0
fi

echo "::error::This pull request changes $total lines; the limit is $limit. Split it, or have a maintainer add the large-change label."
exit 1
