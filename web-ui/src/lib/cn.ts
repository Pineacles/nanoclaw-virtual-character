import { clsx, type ClassValue } from 'clsx';

/** Utility for merging Tailwind classes conditionally. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
