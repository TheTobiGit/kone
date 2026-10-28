import { afterEach, beforeEach, expect, test } from "bun:test";
import { useProviderSignIn } from "./useProviderSignIn";

// The sign-in modal's one shared address: which provider it is up for, and which
// surface hosts it — the app shell (the composer's tray) or the providers pane
// (the deck's pill and the detail's Sign-in block). The state is module-scoped,
// so every test starts from a cleared one.

const signIn = useProviderSignIn();

class FakeHTMLElement {
  focused = 0;
  focus(): void {
    this.focused++;
  }
}

let restoreDom: (() => void) | null = null;

/** Stand in for the browser `open` reads: `activeElement` is the opener it
 *  remembers. Restored by the afterEach below. */
function installDom(opener: FakeHTMLElement): void {
  const previous = ["document", "HTMLElement"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { activeElement: opener },
  });
  restoreDom = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    restoreDom = null;
  };
}

beforeEach(() => {
  // Whatever the last test left open, closed and gone.
  signIn.closed();
});

afterEach(() => {
  restoreDom?.();
});

test("open defaults to the app host", () => {
  signIn.open("cursor");

  expect(signIn.target.value).toBe("cursor");
  expect(signIn.host.value).toBe("app");
});

test("the providers pane hosts its own modal", () => {
  signIn.open("cursor", "pane");

  expect(signIn.target.value).toBe("cursor");
  expect(signIn.host.value).toBe("pane");
});

test("a second open while one is up is ignored, host and all", () => {
  signIn.open("cursor", "pane");
  signIn.open("codex", "app");

  expect(signIn.target.value).toBe("cursor");
  expect(signIn.host.value).toBe("pane");
});

test("closed clears the target and the host, and hands focus back", () => {
  const opener = new FakeHTMLElement();
  installDom(opener);
  signIn.open("cursor", "pane");

  signIn.closed();

  expect(signIn.target.value).toBeNull();
  expect(signIn.host.value).toBe("app");
  expect(opener.focused).toBe(1);
});

test("release clears a pane-hosted modal without reaching for its opener", () => {
  const opener = new FakeHTMLElement();
  installDom(opener);
  signIn.open("cursor", "pane");

  signIn.release("pane");

  expect(signIn.target.value).toBeNull();
  expect(signIn.host.value).toBe("app");
  expect(opener.focused).toBe(0);
});

test("release leaves a modal hosted elsewhere alone", () => {
  signIn.open("cursor");

  signIn.release("pane");

  expect(signIn.target.value).toBe("cursor");
  expect(signIn.host.value).toBe("app");
});

test("a released modal's late close leaves the next modal open", () => {
  // Settings closes mid-exit: the pane releases its card, the composer opens a
  // new one, then the old card's exit callback lands.
  const opener = new FakeHTMLElement();
  installDom(opener);
  signIn.open("cursor", "pane");
  const stale = signIn.ticket();
  signIn.release("pane");
  signIn.open("codex");
  signIn.closed(stale);

  expect(signIn.target.value).toBe("codex");
  expect(signIn.host.value).toBe("app");
  expect(opener.focused).toBe(0);
});

test("a modal's own close still closes it", () => {
  signIn.open("cursor", "pane");
  signIn.closed(signIn.ticket());

  expect(signIn.target.value).toBeNull();
});
