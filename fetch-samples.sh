#!/bin/sh
# Downloads the test files. They live in the rainbow project, not in this repo,
# because rainbow is LGPL-3.0 and this parser is MIT. Run once, then test.
#
#   ./fetch-samples.sh && node test.mjs
#
# Needs git. Pulls about 80 MB and keeps about 12 MB.
set -e
cd "$(dirname "$0")"

if [ -d samples ] && [ -d goldens ]; then
  echo "samples/ and goldens/ are already here. Delete them to download again."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SETS="brown orange pink red yellow"

PATHS=""
for d in $SETS; do
  PATHS="$PATHS tests/inputs/$d.D tests/outputs/$d"
done

echo "Downloading rainbow test data..."
git clone --depth 1 --no-checkout --filter=blob:none \
  https://github.com/evanyeyeye/rainbow.git "$TMP/rainbow" >/dev/null 2>&1
cd "$TMP/rainbow"
git sparse-checkout init --cone >/dev/null 2>&1
# shellcheck disable=SC2086
git sparse-checkout set $PATHS COPYING.LESSER >/dev/null 2>&1
git checkout >/dev/null 2>&1
cd - >/dev/null

mkdir -p samples goldens
for d in $SETS; do
  cp -R "$TMP/rainbow/tests/inputs/$d.D" samples/
  cp -R "$TMP/rainbow/tests/outputs/$d" goldens/
done
cp "$TMP/rainbow/COPYING.LESSER" samples/LICENSE-rainbow-LGPL-3.0.txt

cat > samples/README.md <<'NOTE'
# Where these came from

Every file in samples/ and goldens/ is from the rainbow project by Evan Shi.
`fetch-samples.sh` put them here. None of it was written by this project.

    https://github.com/evanyeyeye/rainbow

rainbow is LGPL-3.0. Its license text sits next to this file. The parser in the
parent folder is MIT and shares no code with rainbow.
NOTE

echo "Done. Now run: node test.mjs"
