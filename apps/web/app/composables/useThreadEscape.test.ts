import { expect, test } from "bun:test";
import { createRenderer, h, nextTick, ref } from "vue";
import { provideThreadEscapeSurface, useThreadEscapeHost } from "./useThreadEscape";

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
});

test("hidden or covered thread hosts leave Escape to the owning surface", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const documentTarget = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget });
  const surfaceOwnsKeys = ref(false);
  const rowVisible = ref(true);
  let dismissed = 0;
  const host = {
    setup() {
      const stack = useThreadEscapeHost(() => rowVisible.value);
      stack.register("rail", () => true, () => { dismissed++; });
      return () => null;
    },
  };
  const app = renderer.createApp({
    setup() {
      provideThreadEscapeSurface(() => surfaceOwnsKeys.value);
      return () => h(host);
    },
  });
  function escape() {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value: "Escape" });
    documentTarget.dispatchEvent(event);
    return event.defaultPrevented;
  }
  try {
    app.mount({});
    await nextTick();
    expect(escape()).toBe(false);
    expect(dismissed).toBe(0);
    surfaceOwnsKeys.value = true;
    rowVisible.value = false;
    expect(escape()).toBe(false);
    expect(dismissed).toBe(0);
    rowVisible.value = true;
    expect(escape()).toBe(true);
    expect(dismissed).toBe(1);
    surfaceOwnsKeys.value = false;
    expect(escape()).toBe(false);
    expect(dismissed).toBe(1);
    app.unmount();
    surfaceOwnsKeys.value = true;
    expect(escape()).toBe(false);
    expect(dismissed).toBe(1);
  } finally {
    app.unmount();
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
