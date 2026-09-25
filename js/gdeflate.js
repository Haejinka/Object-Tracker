(function (global) {
  "use strict";

  // GDeflate splits a DEFLATE block into 32 independent bit lanes inside each
  // 64 KiB tile. This reader decodes those lanes directly; it does not depend
  // on a native codec or on Premiere's private decoder.
  var TILE_BYTES = 65536;
  var LANE_COUNT = 32;
  var CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 3, 3, 3];
  var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 16, 16, 16];
  var DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153];
  var DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];

  function fail(message) { throw new Error("GDeflate: " + message); }

  function bytesOf(input) {
    if (!input || typeof input.length !== "number") fail("input bytes are missing");
    return input;
  }

  function u32le(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function makeHuffman(lengths, maxBits, allowIncomplete) {
    var counts = new Array(maxBits + 1);
    var nextCode = new Array(maxBits + 1);
    var maps = new Array(maxBits + 1);
    var symbol;
    var bits;
    var code = 0;
    var used = 0;
    for (bits = 0; bits <= maxBits; bits++) { counts[bits] = 0; maps[bits] = Object.create(null); }
    for (symbol = 0; symbol < lengths.length; symbol++) {
      bits = lengths[symbol];
      if (bits < 0 || bits > maxBits) fail("invalid Huffman code length");
      if (bits) { counts[bits]++; used++; }
    }
    counts[0] = 0;
    if (!used) fail("empty Huffman tree");
    for (bits = 1; bits <= maxBits; bits++) {
      code = (code + counts[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    var remaining = 1;
    for (bits = 1; bits <= maxBits; bits++) {
      remaining = (remaining << 1) - counts[bits];
      if (remaining < 0) fail("oversubscribed Huffman tree");
    }
    if (!allowIncomplete && remaining !== 0 && used !== 1) fail("incomplete Huffman tree");
    for (symbol = 0; symbol < lengths.length; symbol++) {
      bits = lengths[symbol];
      if (!bits) continue;
      maps[bits][nextCode[bits]++] = symbol;
    }
    return { maps: maps, maxBits: maxBits };
  }

  function fixedTrees() {
    var literalLengths = new Array(288);
    var distanceLengths = new Array(32);
    var i;
    for (i = 0; i <= 143; i++) literalLengths[i] = 8;
    for (i = 144; i <= 255; i++) literalLengths[i] = 9;
    for (i = 256; i <= 279; i++) literalLengths[i] = 7;
    for (i = 280; i <= 287; i++) literalLengths[i] = 8;
    for (i = 0; i < 32; i++) distanceLengths[i] = 5;
    return { literal: makeHuffman(literalLengths, 15, false), distance: makeHuffman(distanceLengths, 15, false) };
  }

  function makeInflater(page, output, outputStart, outputBytes) {
    var input = new Uint8Array(page.length + 8);
    var laneLow = new Uint32Array(LANE_COUNT);
    var laneHigh = new Uint32Array(LANE_COUNT);
    var laneBits = new Uint8Array(LANE_COUNT);
    var pendingLength = new Uint32Array(LANE_COUNT);
    var pendingOutput = new Uint32Array(LANE_COUNT);
    var pendingCopy = new Uint8Array(LANE_COUNT);
    var inputOffset = 0;
    var outputOffset = outputStart;
    var outputEnd = outputStart + outputBytes;
    var lane = 0;

    input.set(page, 0);

    function ensure(count) {
      if (laneBits[lane] >= count) return;
      // GDeflate uses 32-bit packets. A final short packet is zero-padded as
      // specified by the format; the additional zero bytes bound safe reads.
      var packet = u32le(input, inputOffset);
      inputOffset += 4;
      var available = laneBits[lane];
      if (available < 32) {
        laneLow[lane] = (laneLow[lane] | (packet << available)) >>> 0;
        if (available) laneHigh[lane] = (laneHigh[lane] | (packet >>> (32 - available))) >>> 0;
      } else {
        laneHigh[lane] = (laneHigh[lane] | (packet << (available - 32))) >>> 0;
      }
      laneBits[lane] = available + 32;
      if (inputOffset > page.length + 8) fail("truncated tile bitstream");
    }

    function readBits(count) {
      if (!count) return 0;
      ensure(count);
      var value = laneLow[lane] & (count === 32 ? 0xFFFFFFFF : (Math.pow(2, count) - 1));
      if (count < 32) {
        laneLow[lane] = ((laneLow[lane] >>> count) | (laneHigh[lane] << (32 - count))) >>> 0;
        laneHigh[lane] = laneHigh[lane] >>> count;
      } else {
        laneLow[lane] = laneHigh[lane];
        laneHigh[lane] = 0;
      }
      laneBits[lane] -= count;
      return value >>> 0;
    }

    function advance() {
      ensure(32);
      lane = (lane + 1) & (LANE_COUNT - 1);
    }

    function decode(tree) {
      var code = 0;
      var n;
      for (n = 1; n <= tree.maxBits; n++) {
        code = (code << 1) | readBits(1);
        if (Object.prototype.hasOwnProperty.call(tree.maps[n], code)) return tree.maps[n][code];
      }
      fail("invalid Huffman symbol");
    }

    function copyMatch() {
      var distanceSymbol = decode(activeTrees.distance);
      if (distanceSymbol >= DISTANCE_BASE.length) fail("reserved distance symbol");
      var distance = DISTANCE_BASE[distanceSymbol] + readBits(DISTANCE_EXTRA[distanceSymbol]);
      var length = pendingLength[lane];
      var source = pendingOutput[lane] - distance;
      var target = pendingOutput[lane];
      var end = target + length;
      if (source < outputStart || end > outputEnd) fail("back-reference is outside the output tile");
      while (target < end) output[target++] = output[source++];
    }

    var activeTrees = null;

    function finishBlock() {
      var n;
      for (n = 0; n < LANE_COUNT; n++) {
        if (pendingCopy[lane]) {
          copyMatch();
          pendingCopy[lane] = 0;
        }
        advance();
      }
    }

    function decodeCompressedBlock(trees) {
      activeTrees = trees;
      lane = 0;
      while (true) {
        if (!pendingCopy[lane]) {
          var symbol = decode(trees.literal);
          if (symbol < 256) {
            if (outputOffset >= outputEnd) fail("output overrun");
            output[outputOffset++] = symbol;
            advance();
            continue;
          }
          if (symbol === 256) return;
          if (symbol < 257 || symbol > 287) fail("reserved length symbol");
          var lengthIndex = symbol - 257;
          var length = LENGTH_BASE[lengthIndex] + readBits(LENGTH_EXTRA[lengthIndex]);
          if (length > outputEnd - outputOffset) fail("output overrun");
          pendingLength[lane] = length;
          pendingOutput[lane] = outputOffset;
          pendingCopy[lane] = 1;
          outputOffset += length;
        } else {
          copyMatch();
          pendingCopy[lane] = 0;
        }
        advance();
      }
    }

    function decodeDynamicTrees() {
      var literalCount = readBits(5) + 257;
      var distanceCount = readBits(5) + 1;
      var codeLengthCount = readBits(4) + 4;
      var codeLengthLengths = new Array(19);
      var i;
      for (i = 0; i < 19; i++) codeLengthLengths[i] = 0;
      for (i = 0; i < codeLengthCount; i++) {
        codeLengthLengths[CODE_LENGTH_ORDER[i]] = readBits(3);
        advance();
      }
      var codeLengthTree = makeHuffman(codeLengthLengths, 7, true);
      lane = 0;
      var allLengths = [];
      var total = literalCount + distanceCount;
      while (allLengths.length < total) {
        var sym = decode(codeLengthTree);
        if (sym < 16) {
          allLengths.push(sym);
          advance();
        } else {
          var repeated;
          var repeatCount;
          if (sym === 16) {
            if (!allLengths.length) fail("repeat code has no preceding length");
            repeated = allLengths[allLengths.length - 1];
            repeatCount = readBits(2) + 3;
          } else if (sym === 17) {
            repeated = 0;
            repeatCount = readBits(3) + 3;
          } else if (sym === 18) {
            repeated = 0;
            repeatCount = readBits(7) + 11;
          } else fail("invalid code-length symbol");
          if (allLengths.length + repeatCount > total) fail("code-length run exceeds its table");
          while (repeatCount--) allLengths.push(repeated);
          advance();
        }
      }
      var literalLengths = allLengths.slice(0, literalCount);
      var distanceLengths = allLengths.slice(literalCount);
      if (!literalLengths[256]) fail("literal/length tree has no end marker");
      return { literal: makeHuffman(literalLengths, 15, true), distance: makeHuffman(distanceLengths, 15, true) };
    }

    function run() {
      var i;
      for (i = 0; i < LANE_COUNT; i++) advance();
      while (true) {
        lane = 0;
        var finalBlock = readBits(1);
        var blockType = readBits(2);
        ensure(32);
        if (blockType === 0) {
          var count = readBits(16);
          if (count > outputEnd - outputOffset) fail("stored block exceeds output tile");
          while (count--) {
            output[outputOffset++] = readBits(8);
            advance();
          }
          finishBlock();
          if (finalBlock) return;
          continue;
        }
        if (blockType === 1) decodeCompressedBlock(fixedTrees());
        else if (blockType === 2) decodeCompressedBlock(decodeDynamicTrees());
        else fail("reserved DEFLATE block type");
        finishBlock();
        if (finalBlock) return;
      }
    }

    return { run: run };
  }

  function decode(input, expectedBytes) {
    var bytes = bytesOf(input);
    if (bytes.length < 8) fail("frame block is truncated");
    var codecId = bytes[0];
    if (bytes[1] !== (codecId ^ 0xFF) || codecId !== 4) fail("unsupported stream identifier");
    var tileCount = bytes[2] | (bytes[3] << 8);
    if (!tileCount || tileCount > 0xFFFF || 8 + tileCount * 4 > bytes.length) fail("invalid tile table");
    var packed = u32le(bytes, 4);
    var finalTileBytes = (packed >>> 2) & 0x3FFFF;
    if (packed >>> 20) fail("unsupported tile-size flags");
    if (finalTileBytes > TILE_BYTES) fail("invalid last tile size");
    var outputBytes = tileCount * TILE_BYTES - (finalTileBytes ? TILE_BYTES - finalTileBytes : 0);
    if (!outputBytes || (expectedBytes !== undefined && outputBytes !== Number(expectedBytes))) fail("decoded raster size does not match its PRMF rectangle");
    var tableEnd = 8 + tileCount * 4;
    var compressedBytes = bytes.length - tableEnd;
    var offsets = new Array(tileCount);
    var previous = 0;
    var i;
    for (i = 0; i < tileCount; i++) {
      offsets[i] = u32le(bytes, 8 + i * 4);
      if (i > 1 && offsets[i] <= previous) fail("tile offsets are not ordered");
      if (i > 0) previous = offsets[i];
    }
    var finalLength = offsets[0];
    if (!finalLength || finalLength > compressedBytes) fail("last tile offset is outside the compressed data");
    var output = new Uint8Array(outputBytes);
    for (i = 0; i < tileCount; i++) {
      var start = i === 0 ? 0 : offsets[i];
      var end = i === tileCount - 1 ? start + finalLength : offsets[i + 1];
      if (end <= start || end > compressedBytes) fail("tile range is invalid");
      var outStart = i * TILE_BYTES;
      var tileOutputBytes = Math.min(TILE_BYTES, outputBytes - outStart);
      makeInflater(bytes.subarray(tableEnd + start, tableEnd + end), output, outStart, tileOutputBytes).run();
    }
    return output;
  }

  function measureRaster(input, width, height) {
    var raster = bytesOf(input);
    width = Number(width);
    height = Number(height);
    if (!width || !height || raster.length !== width * height) fail("raster dimensions do not match its byte count");
    var left = width, top = height, right = -1, bottom = -1;
    var activePixels = 0;
    var filledPixels = 0;
    var weightedX = 0;
    var weightedY = 0;
    var y, x;
    for (y = 0; y < height; y++) {
      var rowOffset = y * width;
      var first = -1, last = -1, rowActive = 0;
      for (x = 0; x < width; x++) {
        if (raster[rowOffset + x] === 0) continue;
        if (first < 0) first = x;
        last = x;
        rowActive++;
      }
      if (first < 0) continue;
      if (first < left) left = first;
      if (last + 1 > right) right = last + 1;
      if (y < top) top = y;
      bottom = y + 1;
      activePixels += rowActive;
      var span = last - first + 1;
      filledPixels += span;
      weightedX += ((first + last + 1) / 2) * span;
      weightedY += (y + 0.5) * span;
    }
    if (right <= left || bottom <= top || filledPixels <= 0) fail("mask raster contains no usable outline pixels");
    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: right - left,
      height: bottom - top,
      centerX: weightedX / filledPixels,
      centerY: weightedY / filledPixels,
      activePixels: activePixels,
      filledPixels: filledPixels,
      centerMethod: "outline row-span centroid"
    };
  }

  global.ObjectTrackerGDeflate = { decode: decode, measureRaster: measureRaster, tileBytes: TILE_BYTES, laneCount: LANE_COUNT };
}(window));
