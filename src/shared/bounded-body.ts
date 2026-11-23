export type BoundedRead = { kind: 'ok'; bytes: Uint8Array } | { kind: 'too_large' } | { kind: 'non_binary' };

export interface BoundedReadOptions {
  race?: <T>(promise: Promise<T>) => Promise<T>;
  awaitCancel?: boolean;
  signal?: AbortSignal;
}

export async function readBoundedBody(
  body: ReadableStream<unknown>,
  maxBytes: number,
  options: BoundedReadOptions = {},
): Promise<BoundedRead> {
  const reader = body.getReader();
  const race = options.race ?? (<T>(promise: Promise<T>) => promise);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const cancel = async () => {
    if (options.awaitCancel) {
      await race(reader.cancel());
    } else {
      void reader.cancel().catch(() => {});
    }
  };

  try {
    while (true) {
      const { done, value } = await race(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await cancel();
        return { kind: 'non_binary' };
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancel();
        return { kind: 'too_large' };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'ok', bytes };
  } finally {
    if (options.signal?.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
