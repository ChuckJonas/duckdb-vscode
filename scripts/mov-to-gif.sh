#!/usr/bin/env bash
#
# Convert MOV screen recordings to optimized GIFs for README/docs
#
# Usage: ./scripts/mov-to-gif.sh <input.mov> [output.gif]
#
# Settings optimized for demo videos:
#   - Width: 1600px (height auto-calculated to preserve aspect ratio)
#   - Frame rate: 10fps (smooth enough, keeps file size reasonable)
#   - Palette: Generated per-video for best color quality
#
# Requirements: ffmpeg, jq
#
# Example:
#   ./scripts/mov-to-gif.sh ~/Downloads/demo.mov resources/demo.gif

set -e

if [[ -z "$1" ]]; then
    echo "Usage: $0 <input.mov> [output.gif]"
    echo ""
    echo "Example: $0 ~/Downloads/demo.mov resources/demo.gif"
    exit 1
fi

INPUT="$1"
OUTPUT="${2:-${INPUT%.mov}.gif}"

# Settings
WIDTH=1600
FPS=10

# Temp palette file
PALETTE=$(mktemp /tmp/palette-XXXXXX.png)
trap "rm -f $PALETTE" EXIT

echo "Converting: $INPUT"
echo "Output: $OUTPUT"
echo "Settings: ${WIDTH}px width, ${FPS}fps"
echo ""

# Step 1: Generate optimized palette at target resolution
echo "Generating palette..."
ffmpeg -y -i "$INPUT" \
    -vf "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,palettegen" \
    "$PALETTE" 2>/dev/null

# Step 2: Create GIF using the palette
echo "Creating GIF..."
ffmpeg -y -i "$INPUT" -i "$PALETTE" \
    -filter_complex "fps=$FPS,scale=$WIDTH:-1:flags=lanczos[x];[x][1:v]paletteuse" \
    "$OUTPUT" 2>/dev/null

# Report results
SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
DIMS=$(ffprobe -v quiet -print_format json -show_streams "$OUTPUT" | jq -r '.streams[0] | "\(.width)x\(.height)"')

echo ""
echo "Done! Created $OUTPUT"
echo "Size: $SIZE, Dimensions: $DIMS"
