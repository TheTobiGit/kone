/**
 * The spring a floating card (a dock, a menu, a picker popover) pops in on: a
 * little overshoot on the way in, settled within about 400ms. One value, so
 * every card that motion-v animates lands the same way.
 */
export const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
