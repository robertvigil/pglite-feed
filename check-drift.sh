#!/bin/bash
# js/cloud.js is shared verbatim between pglite-activities and pglite-feed.
# It is maintained by discipline alone — nothing links the two copies — so a
# fix applied to one app can silently diverge. This check fails loudly instead.
#
# See ROADMAP.md, "!local — one sync surface, two transports" → Don't forget.
#
# Usage: ./check-drift.sh          # exit 0 if identical, 1 if drifted
set -e

cd "$(dirname "$0")"

SELF="$(basename "$PWD")"
case "$SELF" in
  pglite-activities) SIBLING="../pglite-feed" ;;
  pglite-feed)       SIBLING="../pglite-activities" ;;
  *) echo "check-drift: unrecognised app directory '$SELF' — skipping."; exit 0 ;;
esac

SHARED="js/cloud.js"

if [[ ! -d "$SIBLING" ]]; then
  echo "check-drift: sibling app not checked out at $SIBLING — skipping."
  exit 0
fi

if cmp -s "$SHARED" "$SIBLING/$SHARED"; then
  echo "check-drift: $SHARED identical to $(basename "$SIBLING") ✓"
  exit 0
fi

echo "check-drift: DRIFT — $SHARED differs from $(basename "$SIBLING")/$SHARED" >&2
echo >&2
diff -u "$SIBLING/$SHARED" "$SHARED" | head -60 >&2
echo >&2
echo "Reconcile both copies before deploying. To accept this app's version:" >&2
echo "  cp $SHARED $SIBLING/$SHARED" >&2
exit 1
