export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

export const double = (x: number): number => x * 2;
