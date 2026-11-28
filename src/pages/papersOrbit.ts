/** Room for the card's 1.03 interaction scale and its 3px focus ring. */
export function orbitRadii(width: number, height: number, cardWidth: number, cardHeight: number): { x: number; y: number } {
  const halo = 4;
  const hoverScale = 1.03;
  return {
    x: Math.max(0, (width - cardWidth * hoverScale) / 2 - halo),
    y: Math.max(0, (height - cardHeight * hoverScale) / 2 - halo - 2),
  };
}
