# shellcheck shell=bash
# release-files.lib.sh — shared by scripts/build-edge.sh and
# scripts/build-firefox.sh. Sourced, not executed.
#
# The Chrome release workflow (.github/workflows/release.yml) is the single
# source of truth for which files ship in a package. This helper parses its
# `cp [-r] <src> temp/Walmart-Invoice-Exporter/` lines at runtime, so any file
# added to the workflow in the future automatically flows into the Edge and
# Firefox packages too — no hardcoded duplicate lists to keep in sync.
#
# Lines ending in `|| true` in the workflow are treated as optional (skipped
# if missing); all other listed files are required and abort the build if
# absent. Callers run under `set -euo pipefail`.

RELEASE_WORKFLOW="${RELEASE_WORKFLOW:-.github/workflows/release.yml}"

# copy_release_files <dest-dir>
# Copies every file/directory packaged by the release workflow into <dest-dir>.
# Must be called from the repo root (sources in the workflow are repo-relative).
copy_release_files() {
  _crf_dest="$1"
  _crf_copied=0

  if [ ! -f "$RELEASE_WORKFLOW" ]; then
    echo "error: $RELEASE_WORKFLOW not found (run from the repo root)" >&2
    return 1
  fi

  while IFS= read -r _crf_line; do
    [ -n "$_crf_line" ] || continue

    _crf_optional=0
    case "$_crf_line" in
      *"|| true"*) _crf_optional=1 ;;
    esac

    # Tokenize: cp [-r] SRC temp/Walmart-Invoice-Exporter/ [|| true]
    # shellcheck disable=SC2086
    set -- $_crf_line
    shift # drop 'cp'
    _crf_recursive=0
    if [ "${1:-}" = "-r" ]; then
      _crf_recursive=1
      shift
    fi
    _crf_src="${1:-}"

    if [ -e "$_crf_src" ]; then
      if [ "$_crf_recursive" -eq 1 ]; then
        cp -r "$_crf_src" "$_crf_dest/"
      else
        cp "$_crf_src" "$_crf_dest/"
      fi
      _crf_copied=$((_crf_copied + 1))
    elif [ "$_crf_optional" -eq 1 ]; then
      echo "note: optional '$_crf_src' not present; skipped" >&2
    else
      echo "error: '$_crf_src' is packaged by $RELEASE_WORKFLOW but missing from the repo" >&2
      return 1
    fi
  done < <(grep -E '^[[:space:]]*cp (-r )?[^ ]+ temp/Walmart-Invoice-Exporter/' "$RELEASE_WORKFLOW" || true)

  if [ "$_crf_copied" -eq 0 ]; then
    echo "error: no 'cp ... temp/Walmart-Invoice-Exporter/' lines parsed from $RELEASE_WORKFLOW" >&2
    return 1
  fi

  echo "Copied $_crf_copied entries (derived from $RELEASE_WORKFLOW) into $_crf_dest/"
}
