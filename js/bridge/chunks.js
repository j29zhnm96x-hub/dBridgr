export const CHUNK_SIZE = 16 * 1024;
export const BUFFER_HIGH_WATER_MARK = 512 * 1024;
export const BUFFER_LOW_WATER_MARK = 128 * 1024;
export const LARGE_FILE_WARNING_BYTES = 64 * 1024 * 1024;
export const SOFT_FILE_LIMIT_BYTES = 150 * 1024 * 1024;

export async function* iterateBlobChunks(blob, chunkSize = CHUNK_SIZE) {
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const nextChunk = blob.slice(offset, offset + chunkSize);
    yield {
      offset,
      buffer: await nextChunk.arrayBuffer(),
    };
  }
}

export function needsLargeTransferWarning(file) {
  return Boolean(file?.size >= LARGE_FILE_WARNING_BYTES);
}

export function isOverSoftLimit(file) {
  return Boolean(file?.size >= SOFT_FILE_LIMIT_BYTES);
}

export function computeProgress(transferredBytes, totalBytes) {
  if (!totalBytes) {
    return 0;
  }
  return Math.min(1, transferredBytes / totalBytes);
}

export async function waitForBufferedAmountLow(channel, highWaterMark = BUFFER_HIGH_WATER_MARK) {
  if (!channel || channel.readyState !== 'open') {
    throw new Error('The bridge is not connected yet.');
  }

  if (channel.bufferedAmount <= highWaterMark) {
    return;
  }

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', handleBufferedAmountLow);
      channel.removeEventListener('close', handleClose);
    };

    const handleBufferedAmountLow = () => {
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        cleanup();
        resolve();
      }
    };

    const handleClose = () => {
      cleanup();
      reject(new Error('The bridge closed during a transfer.'));
    };

    channel.addEventListener('bufferedamountlow', handleBufferedAmountLow);
    channel.addEventListener('close', handleClose, { once: true });

    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      cleanup();
      resolve();
    }
  });
}