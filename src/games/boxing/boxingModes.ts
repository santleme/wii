export const BOXING_MODES = [
  { id: 'tutorial', label: 'Tutorial' },
  { id: 'fight', label: 'Luta' },
  { id: 'bag', label: 'Saco de Pancada' },
  { id: 'dodge', label: 'Esquiva' },
] as const;

export type BoxingMode = (typeof BOXING_MODES)[number]['id'];
