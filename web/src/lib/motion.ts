/** Motion tokens for Framer Motion: 200–280 ms ease-out, no springs. */
export const EASE = [0.22, 1, 0.36, 1] as const;
const DUR = { hover: 0.2, enter: 0.24, panel: 0.28, page: 0.26 } as const;
export const enter = { duration: DUR.enter, ease: EASE };
export const panel = { duration: DUR.panel, ease: EASE };
/** Step change: content fades and slides 12 px. */
export const stepEnter = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: DUR.page, ease: EASE } };
