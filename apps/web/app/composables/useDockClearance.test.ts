import { expect, test } from "bun:test";
import { computed, createRenderer, nextTick, ref } from "vue";
import { useDockClearance } from "./useDockClearance";

class DockElement {
  offsetHeight = 0;
}

class DockObserver {
  static instances: DockObserver[] = [];
  observed: Element[] = [];
  constructor(readonly measure: () => void) { DockObserver.instances.push(this); }
  observe(element: Element) { this.observed.push(element); }
  disconnect() { this.observed = []; }
}

const renderer = createRenderer<DockElement, DockElement>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => new DockElement(),
  createText: () => new DockElement(),
  createComment: () => new DockElement(),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
});

test("corner clearance observes late content, grows, and detaches in rail stance", async () => {
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const oldObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: DockElement });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: DockObserver });
  DockObserver.instances = [];
  const dock = new DockElement();
  const railed = ref(false);
  const component = ref({ $el: dock });
  let measured: ReturnType<typeof useDockClearance> | undefined;
  const app = renderer.createApp({
    setup() {
      measured = useDockClearance(computed(() => railed.value ? null : component.value), {
        resting: 132, float: 12, air: 26,
      });
      return () => null;
    },
  });
  try {
    app.mount(new DockElement());
    expect(measured?.clear.value).toBe(132);
    expect(DockObserver.instances[0]?.observed).toHaveLength(1);
    dock.offsetHeight = 180;
    DockObserver.instances[0]?.measure();
    expect(measured?.clear.value).toBe(218);
    dock.offsetHeight = 360;
    DockObserver.instances[0]?.measure();
    expect(measured?.clear.value).toBe(398);
    railed.value = true;
    await nextTick();
    expect(measured?.clear.value).toBe(132);
    expect(DockObserver.instances[0]?.observed).toHaveLength(0);
    railed.value = false;
    await nextTick();
    expect(measured?.clear.value).toBe(398);
    expect(DockObserver.instances[1]?.observed).toHaveLength(1);
    app.unmount();
    expect(DockObserver.instances[1]?.observed).toHaveLength(0);
  } finally {
    app.unmount();
    if (oldElement) Object.defineProperty(globalThis, "HTMLElement", oldElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
    if (oldObserver) Object.defineProperty(globalThis, "ResizeObserver", oldObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
