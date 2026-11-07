#!/usr/bin/env bash
# Fail when a tracked text file has a UTF-8 BOM or CRLF line endings.
# Binary files are detected with git-check-attr (text unset) plus a small
# extension allowlist, so extension-less text files such as .gitignore are
# covered too.
set -eu

failed=0
checked=0
skipped=0

while IFS= read -r file; do
  [ -f "$file" ] || continue

  attr=$(git check-attr text -- "$file" | sed 's/^.*: //')
  if [ "$attr" = "unset" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.gz|*.tar|*.bmp|*.avif|*.woff|*.woff2)
      skipped=$((skipped + 1))
      continue
      ;;
  esac

  checked=$((checked + 1))

  bom=$(head -c 3 "$file" | od -An -tx1 | tr -d ' \n')
  if [ "$bom" = "efbbbf" ]; then
    echo "BOM: $file"
    failed=1
  fi

  if LC_ALL=C grep -q $'\r' "$file"; then
    echo "CRLF: $file"
    failed=1
  fi
done < <(git ls-files)

echo "checked=$checked skipped=$skipped"
if [ "$failed" -ne 0 ]; then
  echo "encoding guard failed"
  exit 1
fi
echo "encoding guard passed"
