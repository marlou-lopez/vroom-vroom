import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CarModelControl } from "./CarModelControl";
import { Cancelled, type StartConversion } from "./convert/client.ts";
import { ConvertError } from "./convert/fileSet.ts";
import { LARGE_MODEL_BYTES, READ_ERROR, createMemoryCarModelStore, type StoredCarModel } from "./carModelStore";

const CARS = [{ carId: "car_a", name: "McLaren 720S" }, { carId: "car_b", name: "Porsche 911" }];
const glb = (n = 16) => { const b = new ArrayBuffer(n); new DataView(b).setUint32(0, 0x46546c67, true); return b; };
const rec = (over: Partial<StoredCarModel> = {}): StoredCarModel =>
  ({ carId: "car_a", bytes: glb(), fileName: "mc.glb", size: 2.3 * 1024 * 1024, addedAt: 1, rotate180: false, ...over });

async function open(props: Partial<React.ComponentProps<typeof CarModelControl>> = {}, optimise = false) {
  const store = props.store ?? createMemoryCarModelStore();
  const user = userEvent.setup({ applyAccept: false });
  render(<CarModelControl cars={CARS} store={store} probe={async () => false} validate={async () => undefined} {...props} />);
  await user.click(screen.getByRole("button", { name: "Car" }));
  if (!optimise) for (const box of screen.getAllByRole("checkbox", { name: "Optimise" })) await user.click(box);
  return { store, user };
}

const fileOf = (bytes: ArrayBuffer | string, name = "x.glb", size?: number) => {
  const f = new File([bytes], name);
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("CarModelControl", () => {
  it("shows each car with its current source", async () => {
    const store = createMemoryCarModelStore();
    await store.put(rec());
    await open({ store, probe: async (u) => u.includes("car_b") });
    expect(await screen.findByText("Your model: mc.glb (2.3 MB)")).toBeTruthy();
    expect(await screen.findByText("Local file")).toBeTruthy();
    expect(screen.getByText("McLaren 720S")).toBeTruthy();
    expect(screen.getByText(/isn't uploaded/)).toBeTruthy();
  });

  it("shows the box when there is nothing, and lists a shared car once", async () => {
    await open({ cars: [CARS[0], CARS[0]] });
    expect(await screen.findAllByTestId("car-source")).toHaveLength(1);
    expect(screen.getByTestId("car-source").textContent).toContain("Box");
  });

  it("stores a valid file and shows it as the source", async () => {
    const { store, user } = await open();
    await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), fileOf(glb(), "mine.glb"));
    await waitFor(() => expect(screen.getAllByTestId("car-source")[0].textContent).toContain("Your model: mine.glb"));
    expect((await store.get("car_a"))?.fileName).toBe("mine.glb");
  });

  it("shows an error and stores nothing for an invalid file", async () => {
    const { store, user } = await open();
    await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), fileOf("not a model", "bad.glb"));
    expect((await screen.findByRole("alert")).textContent).toBe(READ_ERROR);
    expect(await store.get("car_a")).toBeNull();
  });

  it("shows the error when the loader rejects a file that has the glb header, and keeps the current model", async () => {
    const store = createMemoryCarModelStore();
    await store.put(rec());
    const { user } = await open({ store, validate: async () => { throw new Error("bad"); } });
    await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), fileOf(glb(), "broken.glb"));
    expect((await screen.findByRole("alert")).textContent).toBe(READ_ERROR);
    expect((await store.get("car_a"))?.fileName).toBe("mc.glb");
  });

  it("warns about a large file but still stores it", async () => {
    const { store, user } = await open();
    await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), fileOf(glb(LARGE_MODEL_BYTES + 1), "big.glb"));
    expect((await screen.findByRole("status")).textContent).toMatch(/optimize-car-model/);
    expect(await store.get("car_a")).not.toBeNull();
  });

  it("Remove calls the store and returns to the box; Rotate toggles the flag", async () => {
    const store = createMemoryCarModelStore();
    await store.put(rec());
    const remove = vi.spyOn(store, "remove");
    const setRotate = vi.spyOn(store, "setRotate");
    const { user } = await open({ store });
    await screen.findByText(/Your model/);
    await user.click(screen.getAllByRole("button", { name: "Rotate 180°" })[0]);
    expect(setRotate).toHaveBeenCalledWith("car_a", true);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Rotate 180°" })[0].getAttribute("aria-pressed")).toBe("true"));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(remove).toHaveBeenCalledWith("car_a");
    await waitFor(() => expect(screen.getAllByTestId("car-source")[0].textContent).toContain("Box"));
  });

  describe("conversion", () => {
    const stats = { bytesBefore: 46_000_000, bytesAfter: 2_300_000, trianglesBefore: 473_493, trianglesAfter: 115_071 };
    const done = (): StartConversion => vi.fn((_f, _o, onStage) => {
      onStage("simplifying");
      return { promise: Promise.resolve({ glb: glb(), stats, dropped: 3 }), cancel: vi.fn() };
    });

    it("converts a zip in the worker, shows before and after, and stores the result", async () => {
      const convert = done();
      const { store, user } = await open({ convert }, true);
      await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), new File([new Uint8Array([80, 75, 3, 4])], "720s.zip"));
      await waitFor(() => expect(screen.getAllByTestId("car-source")[0].textContent).toContain("720s.glb"));
      expect(convert).toHaveBeenCalledTimes(1);
      const [files, opts] = (convert as unknown as { mock: { calls: [{ path: string }[], { optimise: boolean }][] } }).mock.calls[0];
      expect(files.map((f) => f.path)).toEqual(["720s.zip"]);
      expect(opts.optimise).toBe(true);
      const note = screen.getAllByRole("status").map((n) => n.textContent).join(" ");
      expect(note).toContain("Optimised:");
      expect(note).toContain("473,493 to 115,071 triangles");
      expect((await store.get("car_a"))?.fileName).toBe("720s.glb");
    });

    it("converts a picked folder using the paths of its files", async () => {
      const convert = done();
      const { user } = await open({ convert }, true);
      const f = (name: string, path: string) => { const x = new File(["x"], name); Object.defineProperty(x, "webkitRelativePath", { value: path }); return x; };
      await user.upload(screen.getByLabelText("Load folder for McLaren 720S"), [f("scene.gltf", "mclaren/scene.gltf"), f("scene.bin", "mclaren/scene.bin")]);
      await waitFor(() => expect(convert).toHaveBeenCalled());
      const files = (convert as unknown as { mock: { calls: [{ path: string }[]][] } }).mock.calls[0][0];
      expect(files.map((x) => x.path)).toEqual(["mclaren/scene.gltf", "mclaren/scene.bin"]);
      await waitFor(() => expect(screen.getAllByTestId("car-source")[0].textContent).toContain("mclaren.glb"));
    });

    it("sends a plain .glb through the converter when Optimise is on, but not a small compressed one", async () => {
      const convert = done();
      const { user } = await open({ convert }, true);
      await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), fileOf(glb(), "raw.glb"));
      await waitFor(() => expect(convert).toHaveBeenCalledTimes(1));
      const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression"] }).padEnd(64, " "));
      const bytes = new Uint8Array(20 + json.length), dv = new DataView(bytes.buffer);
      dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, bytes.length, true);
      dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); bytes.set(json, 20);
      await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), fileOf(bytes.buffer, "small.glb"));
      await waitFor(() => expect(screen.getAllByTestId("car-source")[0].textContent).toContain("small.glb"));
      expect(convert).toHaveBeenCalledTimes(1);
    });

    it("shows progress with a Cancel button that stops the worker and keeps the current model", async () => {
      const store = createMemoryCarModelStore();
      await store.put(rec());
      const cancel = vi.fn();
      let reject: (e: unknown) => void = () => undefined;
      const convert: StartConversion = (_f, _o, onStage) => {
        onStage("cleaning");
        return { promise: new Promise((_ok, no) => { reject = no; }), cancel: () => { cancel(); reject(new Cancelled()); } };
      };
      const { user } = await open({ store, convert }, true);
      await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), new File(["x"], "a.zip"));
      expect((await screen.findByText("Step 2 of 6: Cleaning…")).textContent).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(cancel).toHaveBeenCalled();
      await waitFor(() => expect(screen.getAllByRole("status").map((n) => n.textContent).join(" ")).toContain("Cancelled"));
      expect((await store.get("car_a"))?.fileName).toBe("mc.glb");
    });

    it("shows a conversion error inline and stores nothing", async () => {
      const convert: StartConversion = () => ({ promise: Promise.reject(new ConvertError("missing-file", 'The model refers to "scene.bin", which wasn\'t in the files you chose.')), cancel: vi.fn() });
      const { store, user } = await open({ convert }, true);
      await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), new File(["{}"], "scene.gltf"));
      expect((await screen.findByRole("alert")).textContent).toContain("scene.bin");
      expect(await store.get("car_a")).toBeNull();
    });

    it("rejects an unsupported extension before starting the worker", async () => {
      const convert = done();
      const { user } = await open({ convert }, true);
      await user.upload(screen.getByLabelText("Load .glb for McLaren 720S"), new File(["x"], "car.obj"));
      expect((await screen.findByRole("alert")).textContent).toContain("Unsupported file type (.obj)");
      expect(convert).not.toHaveBeenCalled();
    });
  });
});
