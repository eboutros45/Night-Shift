import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function setup(stop = vi.fn(async () => {})) {
  const events: Record<string, (event?: any) => any> = {};
  const form = { requestSubmit: vi.fn(), addEventListener: (name: string, fn: any) => { events[`form:${name}`] = fn; } };
  const toggle = { hidden: true, disabled: false, textContent: "", addEventListener: (name: string, fn: any) => { events[`toggle:${name}`] = fn; } };
  const input = { value: "", focus: vi.fn() };
  const result = { textContent: "" };
  let decode: (code: string) => void = () => {};
  const pause = vi.fn();
  class Camera {
    pause = pause;
    stop = stop;
    start = vi.fn(async (_camera, _options, callback) => { decode = callback; });
  }
  const elements: Record<string, unknown> = { "scan-form": form, "cam-toggle": toggle, code: input, result };
  runInNewContext(readFileSync("public/door.js", "utf8"), { document: { getElementById: (id: string) => elements[id] }, window: { Html5Qrcode: Camera }, Html5Qrcode: Camera });
  return { form, toggle, input, pause, stop, events, decode: (code: string) => decode(code) };
}

it("submits only one QR while camera shutdown is pending and ignores all later frames", async () => {
  let finish!: () => void;
  const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const ui = setup(stop);
  await ui.events["toggle:click"]!();
  ui.decode("ticket-one");
  ui.decode("ticket-two");
  expect(ui.pause).toHaveBeenCalledWith(true);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(ui.form.requestSubmit).not.toHaveBeenCalled();
  finish();
  await new Promise(resolve => setImmediate(resolve));
  expect(ui.form.requestSubmit).toHaveBeenCalledTimes(1);
  expect(ui.input.value).toBe("ticket-one");
  ui.decode("ticket-one");
  ui.decode("ticket-three");
  await ui.events["toggle:click"]!();
  expect(ui.form.requestSubmit).toHaveBeenCalledTimes(1);
  expect(ui.toggle.disabled).toBe(true);
});

it("still submits once if the camera fails to stop", async () => {
  const ui = setup(vi.fn(async () => { throw new Error("camera disconnected"); }));
  await ui.events["toggle:click"]!();
  ui.decode("ticket-one");
  await new Promise(resolve => setImmediate(resolve));
  ui.decode("ticket-two");
  expect(ui.form.requestSubmit).toHaveBeenCalledTimes(1);
});

it("stops camera scanning when the operator submits a typed code", async () => {
  const ui = setup();
  await ui.events["toggle:click"]!();
  ui.input.value = "typed-ticket";
  const preventDefault = vi.fn();
  ui.events["form:submit"]!({ preventDefault });
  ui.decode("other-ticket");
  await new Promise(resolve => setImmediate(resolve));
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(ui.form.requestSubmit).toHaveBeenCalledTimes(1);
  expect(ui.input.value).toBe("typed-ticket");
});
