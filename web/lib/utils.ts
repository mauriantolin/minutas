import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Speaker accent color: index of first appearance modulo 5 → chart token. */
export function chartColor(speakerIndex: number): string {
  return `var(--chart-${(speakerIndex % 5) + 1})`;
}
