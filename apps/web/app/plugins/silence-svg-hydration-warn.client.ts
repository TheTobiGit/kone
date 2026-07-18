// @hugeicons/vue@1.0.7 renders <svg :width="size" :height="size"> with numeric
// values. During SSR hydration Vue tries to assign them as DOM properties
// (el.width = 18) rather than attributes, and SVGSVGElement.width is read-only —
// so it logs a "Failed setting prop width/height on <svg>" warning on every
// Hugeicons icon. The icons still render correctly (the SSR'd attributes are
// right; Vue catches the error and moves on), so this is pure dev noise from a
// third-party lib with no newer release to upgrade to.
//
// Filter exactly that one warning, dev-only, and pass everything else straight
// through untouched. Warnings are stripped from production builds entirely, so
// this handler never runs there.
export default defineNuxtPlugin((nuxtApp) => {
  if (!import.meta.dev) return;

  const app = nuxtApp.vueApp;
  const previous = app.config.warnHandler;

  app.config.warnHandler = (msg, instance, trace) => {
    if (
      msg.includes("Failed setting prop") &&
      msg.includes("<svg>") &&
      (msg.includes('"width"') || msg.includes('"height"'))
    ) {
      return;
    }
    if (previous) {
      previous(msg, instance, trace);
    } else {
      console.warn(`[Vue warn]: ${msg}${trace}`);
    }
  };
});
