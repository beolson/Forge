import { expect, test, vi } from "vitest";
import { eventResponse } from "./events.server";

test("disconnect removes the subscription and late events cannot write to a cancelled stream", async () => {
  const abort = new AbortController();
  const unsubscribe = vi.fn();
  let notify = (_value: object) => {};
  let close = () => {};
  const response = eventResponse(
    new Request("http://forge/events", { signal: abort.signal }),
    (send, finish) => {
      notify = send;
      close = finish;
      return unsubscribe;
    },
  );
  const reader = response.body?.getReader();
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
    'data: {"ready":true}\n\n',
  );
  await reader?.cancel();
  abort.abort();
  expect(() => {
    notify({ late: true });
    close();
  }).not.toThrow();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("an already aborted request closes immediately and unsubscribes", async () => {
  const unsubscribe = vi.fn();
  const response = eventResponse(
    new Request("http://forge/events", { signal: AbortSignal.abort() }),
    () => unsubscribe,
  );
  const reader = response.body?.getReader();
  await reader?.read();
  expect((await reader?.read())?.done).toBe(true);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
