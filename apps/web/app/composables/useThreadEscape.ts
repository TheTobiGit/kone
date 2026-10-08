import { getCurrentInstance, inject, onScopeDispose, provide, type InjectionKey } from "vue";
import { useEventListener } from "@vueuse/core";
import { createThreadEscapeStack, type ThreadEscapeLayer } from "../utils/threadEscape";

type EscapeStack = ReturnType<typeof createThreadEscapeStack>;
const threadEscapeKey: InjectionKey<EscapeStack> = Symbol("thread-escape");
const surfaceGateKey: InjectionKey<() => boolean> = Symbol("thread-escape-surface");

export function provideThreadEscapeSurface(enabled: () => boolean): void {
  provide(surfaceGateKey, enabled);
}

export function useThreadEscapeHost(enabled: () => boolean): EscapeStack {
  const stack = createThreadEscapeStack();
  const surfaceEnabled = inject(surfaceGateKey, () => true);
  provide(threadEscapeKey, stack);
  // DOM pickers get their target/capture handlers first; window listeners for
  // the surrounding portal only see presses no thread layer has consumed.
  useEventListener(() => globalThis.document, "keydown", (event: KeyboardEvent) => {
    if (surfaceEnabled() && enabled()) stack.handle(event);
  });
  return stack;
}

export function useThreadEscape() {
  const host = inject(threadEscapeKey, null);
  const stack = host ?? createThreadEscapeStack();
  // Composers and change lists also appear outside a live thread host.
  if (!host) {
    const instance = getCurrentInstance();
    useEventListener(() => globalThis.document, "keydown", (event: KeyboardEvent) => {
      const root = instance?.vnode.el;
      if (!(root instanceof HTMLElement) || root.closest("[inert]")) return;
      if (!(event.target instanceof Node) || !root.contains(event.target)) return;
      stack.handle(event);
    });
  }
  return (kind: ThreadEscapeLayer, active: () => boolean, dismiss: (() => void) | null): void => {
    onScopeDispose(stack.register(kind, active, dismiss));
  };
}
