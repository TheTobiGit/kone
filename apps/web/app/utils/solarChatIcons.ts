// The chat marks as icon data, in the same `[tag, attrs]` shape as the
// Hugeicons set — so `<HugeiconsIcon>` draws them and every registry or icon
// map stays a plain data table with no per-kind render branch.
//
// Two variants of one mark (a round bubble with two text lines): the plain
// outline is the default conversation icon everywhere a thread is represented,
// and the broken outline — the same shell with a gap — is only ever worn by
// side chats, where the opening is what tells a fork apart at a glance.
// Attr keys stay camelCase like the Hugeicons data; the renderer kebabs them.
// strokeWidth 1.5 is baked in as the resting weight and any explicit
// `:stroke-width` prop overrides it, exactly like the set's own icons.

export type IconPaths = readonly (readonly [
  string,
  Readonly<Record<string, string | number>>,
])[];

export const SolarChatRoundLineLinearIcon: IconPaths = [
  [
    "path",
    {
      d: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M8 10.5h8M8 14h5.5",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "1",
    },
  ],
];

export const SolarChatRoundLineBrokenIcon: IconPaths = [
  [
    "path",
    {
      d: "M8 10.5h8M8 14h5.5M17 3.338A9.95 9.95 0 0 0 12 2C6.477 2 2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22c5.523 0 10-4.477 10-10c0-1.821-.487-3.53-1.338-5",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
];
