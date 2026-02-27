#!/bin/bash
# Build the NanoClaw agent container image
#
# Usage:
#   ./build.sh                                    # local: nanoclaw-agent:latest
#   ./build.sh user/nanoclaw-agent                # tag for Docker Hub (no push)
#   ./build.sh user/nanoclaw-agent --push         # build + push (version + latest tags)
#
# After pushing, set CONTAINER_IMAGE in .env to pull from the registry:
#   CONTAINER_IMAGE=user/nanoclaw-agent:latest

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Parse args: first non-flag arg is image ref, --push enables push
IMAGE_REF=""
PUSH=false
for arg in "$@"; do
  if [ "$arg" = "--push" ]; then
    PUSH=true
  elif [ -z "$IMAGE_REF" ]; then
    IMAGE_REF="$arg"
  fi
done

# Default to local image name if no ref given
if [ -z "$IMAGE_REF" ]; then
  IMAGE_REF="nanoclaw-agent"
fi

# Strip any tag from IMAGE_REF — we control the tags from package.json
IMAGE_BASE="${IMAGE_REF%%:*}"

# Read version from package.json
VERSION="$(node -p "require('../package.json').version")"
VERSION_TAG="${IMAGE_BASE}:${VERSION}"
LATEST_TAG="${IMAGE_BASE}:latest"

echo "Building NanoClaw agent container image..."
echo "Version: ${VERSION}"
echo "Tags: ${VERSION_TAG}, ${LATEST_TAG}"
echo ""

${CONTAINER_RUNTIME} build -t "${VERSION_TAG}" .
${CONTAINER_RUNTIME} tag "${VERSION_TAG}" "${LATEST_TAG}"

echo ""
echo "Build complete!"
echo "  ${VERSION_TAG}"
echo "  ${LATEST_TAG}"

if [ "$PUSH" = true ]; then
  echo ""
  echo "Pushing..."
  ${CONTAINER_RUNTIME} push "${VERSION_TAG}"
  ${CONTAINER_RUNTIME} push "${LATEST_TAG}"
  echo ""
  echo "Push complete!"
  echo ""
  echo "Add to your .env:"
  echo "  CONTAINER_IMAGE=${LATEST_TAG}"
fi

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${LATEST_TAG}"
