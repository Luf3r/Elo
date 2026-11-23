import { describe, expect, it } from 'vitest';
import { readBoundedBody } from '../../src/shared/bounded-body';

function byteStream(...chunks: Uint8Array[]) {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('readBoundedBody', () => {
  it('accepts the exact limit and joins multiple chunks', async () => {
    const result = await readBoundedBody(byteStream(new Uint8Array([1, 2]), new Uint8Array([3])), 3);

    expect(result).toEqual({ kind: 'ok', bytes: new Uint8Array([1, 2, 3]) });
  });

  it('cancels when the body exceeds the limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
      },
      cancel() {
        cancelled = true;
      },
    });

    expect(await readBoundedBody(body, 2)).toEqual({ kind: 'too_large' });
    expect(cancelled).toBe(true);
  });

  it('returns non_binary before checking the size and cancels the body', async () => {
    let cancelled = false;
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not bytes');
      },
      cancel() {
        cancelled = true;
      },
    });

    expect(await readBoundedBody(body, 0)).toEqual({ kind: 'non_binary' });
    expect(cancelled).toBe(true);
  });

  it('waits for cancellation when awaitCancel is true', async () => {
    let cancellationFinished = false;
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not bytes');
      },
      async cancel() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        cancellationFinished = true;
      },
    });

    const result = await readBoundedBody(body, 10, { awaitCancel: true });

    expect(result).toEqual({ kind: 'non_binary' });
    expect(cancellationFinished).toBe(true);
  });

  it('does not wait for cancellation when awaitCancel is false or propagate its rejection', async () => {
    let finishCancellation!: () => void;
    let cancellationStarted = false;
    const cancellation = new Promise<void>((_resolve, reject) => {
      finishCancellation = () => reject(new Error('cancel failed'));
    });
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not bytes');
      },
      cancel() {
        cancellationStarted = true;
        return cancellation;
      },
    });

    await expect(readBoundedBody(body, 10)).resolves.toEqual({ kind: 'non_binary' });
    expect(cancellationStarted).toBe(true);
    finishCancellation();
  });

  it('propagates a rejected race', async () => {
    const body = byteStream(new Uint8Array([1]));
    const failure = new Error('read race failed');

    await expect(
      readBoundedBody(body, 1, {
        race: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('cancels in finally when the signal is already aborted', async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<unknown>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const signal = AbortSignal.abort();

    const result = await readBoundedBody(body, 10, {
      signal,
      race: async <T>(promise: Promise<T>) => {
        reads++;
        if (reads === 2) return { done: true, value: undefined } as T;
        return promise;
      },
    });

    expect(result).toEqual({ kind: 'ok', bytes: new Uint8Array([1]) });
    expect(cancelled).toBe(true);
  });

  it('returns an empty byte array for an empty body', async () => {
    expect(await readBoundedBody(byteStream(), 0)).toEqual({ kind: 'ok', bytes: new Uint8Array() });
  });
});
