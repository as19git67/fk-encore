#!/usr/bin/env sh
# Keeps the iOS build number in step with the repository.
#
# `CURRENT_PROJECT_VERSION` used to be a hand edit in the Xcode project,
# and it fell sixteen pull requests behind: something that has to be
# remembered on every change is something that will be forgotten on most
# of them. The commit count is the one number that already moves with
# every change and never goes backwards, so the build number is now
# derived from it — by the pre-commit hook, so the value stays visible in
# the diff and identical for both targets (the app and its share
# extension must carry the same CFBundleVersion).
#
# Runs only when the commit touches `ios/`, never lowers the number, and
# does nothing at all in a shallow checkout, where the count is smaller
# than the history it was cut from.
set -eu

project="ios/FKPhotos.xcodeproj/project.pbxproj"
[ -f "$project" ] || exit 0

# Nothing iOS in this commit, nothing to bump.
if ! git diff --cached --name-only --diff-filter=ACMR | grep -q '^ios/'; then
    exit 0
fi

if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    echo "ios: shallow checkout — build number left as is"
    exit 0
fi

# The number this commit will have once it exists.
next=$(( $(git rev-list --count HEAD) + 1 ))
current=$(sed -n 's/.*CURRENT_PROJECT_VERSION = \([0-9][0-9]*\);.*/\1/p' "$project" | head -1)
: "${current:=0}"

if [ "$next" -le "$current" ]; then
    # A rebase or a branch with fewer commits behind it. A build number
    # that goes down is one the App Store refuses.
    exit 0
fi

sed -i.bak "s/CURRENT_PROJECT_VERSION = [0-9][0-9]*;/CURRENT_PROJECT_VERSION = ${next};/g" "$project"
rm -f "${project}.bak"
git add "$project"
echo "ios: build number ${current} → ${next}"
