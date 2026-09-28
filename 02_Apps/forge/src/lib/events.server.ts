export function eventResponse(
  request: Request,
  subscribe: (send: (value: object) => void, close: () => void) => () => void,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let close = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    request.signal.removeEventListener("abort", close);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };
      const send = (value: object) => {
        if (!closed)
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          );
      };
      unsubscribe = subscribe(send, close);
      send({ ready: true });
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
