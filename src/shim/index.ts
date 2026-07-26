export interface ShimOptions {
  handle: string;
}

export async function runShim(_opts: ShimOptions): Promise<void> {
  throw new Error('shim not implemented yet');
}
