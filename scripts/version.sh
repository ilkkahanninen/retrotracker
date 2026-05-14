#!/usr/bin/env bash

set -e

# Get latest tag
LATEST_TAG=$(git describe --tags --abbrev=0)

# Count commits after latest tag
COMMITS_AFTER=$(git rev-list "${LATEST_TAG}"..HEAD --count)

# Create version string
VERSION="${LATEST_TAG}.${COMMITS_AFTER}"

echo "$VERSION"
